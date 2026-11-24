import type {ChatMessage} from '../domain/types';
import type {ModeratorAgent} from '../ai/moderator-agent';
import type {MemoryStore} from '../domain/memory-store';
import type {AutonomousOperator} from './autonomous-operator';
import type {InboundPlanner} from './inbound-planner';
import type {JevRouteRequest, RoutingDecision} from '../ai/model-router';

type DecisionResult=Awaited<ReturnType<ModeratorAgent['processInboundMessage']>>;
type CoordinatorDependencies={
  moderator:Pick<ModeratorAgent,'processInboundMessage'>;
  memory:Pick<MemoryStore,'getChat'>;
  operator:Pick<AutonomousOperator,'resolve'>;
  /** Explicit owner opt-in supplied by createInboundPlanner. */
  planner?:Pick<InboundPlanner,'process'>;
  brandId?:string;
  enabled:boolean;
  router?:(input:JevRouteRequest)=>Promise<RoutingDecision>;
};
/** Opt-in verified-data lane; general conversation and sensitive decisions retain moderator policy. */
export class AgentTurnCoordinator {
  private active=new Map<string,Promise<void>>();
  private readonly turnTimeoutMs: number;
  constructor(private readonly deps:CoordinatorDependencies, options: { turnTimeoutMs?: number } = {}){
    this.turnTimeoutMs = options.turnTimeoutMs ?? 45_000;
  }
  async processInboundMessage(message:ChatMessage,delivery?:{historical?:boolean;replayed?:boolean}):Promise<DecisionResult>{
    if(delivery?.historical||delivery?.replayed)return {
      decision:{action:'ignore',intent:'replay',reasoning:'Historical or replayed inbound message',confidence:1,simulatedDelayMs:0},
      shouldSendImmediately:false
    };
    const prior=this.active.get(message.chatId)??Promise.resolve();
    let release!:()=>void;
    const ready=new Promise<void>(resolve=>{release=resolve;});
    const pending=prior.then(()=>ready);
    this.active.set(message.chatId,pending);

    let priorTimer: ReturnType<typeof setTimeout> | undefined;
    const boundedPrior = Promise.race([
      prior,
      new Promise<void>((_, reject) => {
        priorTimer = setTimeout(() => reject(new Error('Turn queue timeout waiting for prior turn')), this.turnTimeoutMs);
      })
    ]).finally(() => {
      if (priorTimer) clearTimeout(priorTimer);
    });

    try {
      await boundedPrior;
    } catch (err) {
      console.warn('[AgentTurnCoordinator] Prior turn queue settled with error or timeout:', err);
    }

    let turnTimer: ReturnType<typeof setTimeout> | undefined;
    const boundedProcess = Promise.race([
      this.process(message),
      new Promise<never>((_, reject) => {
        turnTimer = setTimeout(() => reject(new Error(`Agent turn timed out after ${this.turnTimeoutMs}ms`)), this.turnTimeoutMs);
      })
    ]).finally(() => {
      if (turnTimer) clearTimeout(turnTimer);
    });

    try{return await boundedProcess;}
    catch (err: any) {
      return {
        decision: {
          action: 'draft',
          intent: 'processing_timeout',
          reasoning: `Turn processing error or timeout: ${err?.message || 'unknown'}`,
          confidence: 0,
          simulatedDelayMs: 0
        },
        shouldSendImmediately: false
      };
    }
    finally {
      release();
      if(this.active.get(message.chatId)===pending)this.active.delete(message.chatId);
    }
  }
  private async process(message:ChatMessage):Promise<DecisionResult>{
    const activeMode=this.deps.memory.getChat(message.chatId)?.agentMode??'autopilot';
    if(this.deps.planner&&activeMode==='autopilot'&&!message.isFromMe&&message.type==='text'&&
       !message.chatId.endsWith('@g.us')){
      try{
        const planned=await this.deps.planner.process(message);
        if(planned)return planned;
      }catch{
        // A failed durable replay guard may conceal a completed provider write.
        return {decision:{action:'ignore',intent:'provider_unknown',reasoning:'Inbound planner failed closed',confidence:1,simulatedDelayMs:0},shouldSendImmediately:false};
      }
    }
    const validBrand=!!this.deps.brandId && /^[A-Za-z0-9_-]{1,64}$/.test(this.deps.brandId);
    const readOnlyStock=/\bSKU[-_][A-Za-z0-9_-]{1,80}\b/i.test(message.text??'');
    const permitted=this.deps.enabled && validBrand && activeMode==='autopilot' &&
      !message.isFromMe && message.type==='text' && !message.chatId.endsWith('@g.us') && readOnlyStock;
    if(!permitted)return this.deps.moderator.processInboundMessage(message);
    try{
      const resolved=await this.deps.operator.resolve({
        brandId:this.deps.brandId!,contactId:message.chatId,text:message.text,
        workflowId:message.chatId+':'+message.id
      });
      const confirmed=resolved.status==='answered' && resolved.evidence.some(e=>e.kind==='provider');
      if(confirmed && resolved.reply.trim()){
        return {
          decision:{
            action:'reply',intent:'general_faq',replyText:resolved.reply,
            reasoning:'Verified read-only inventory connector',confidence:1,
            simulatedDelayMs:0,sendAsVoiceNote:false
          },shouldSendImmediately:true
        };
      }
    }catch{ /* provider/model failures retain the existing moderation path */ }
    return this.deps.moderator.processInboundMessage(message);
  }
}
