import { describeError, logEvent } from '../observability/safe-log';

export type ShutdownPhase = 'stop_ingestion' | 'drain_queues' | 'disconnect_transport' | 'close_datastores';

export interface TeardownTask {
  name: string;
  phase: ShutdownPhase;
  action: () => Promise<void> | void;
}

const PHASE_ORDER: ShutdownPhase[] = [
  'stop_ingestion',
  'drain_queues',
  'disconnect_transport',
  'close_datastores'
];

export class ProcessLifecycleCoordinator {
  private tasks: TeardownTask[] = [];
  private isShuttingDown = false;
  private signalAttached = false;
  private timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  register(name: string, phase: ShutdownPhase, action: () => Promise<void> | void): () => void {
    const task: TeardownTask = { name, phase, action };
    this.tasks.push(task);
    return () => {
      const idx = this.tasks.indexOf(task);
      if (idx !== -1) this.tasks.splice(idx, 1);
    };
  }

  attachSignalHandlers(): void {
    if (this.signalAttached) return;
    this.signalAttached = true;

    const handleSignal = (signal: string) => {
      console.log(`\n🛑 [Lifecycle] Received ${signal}. Initiating graceful shutdown...`);
      void this.shutdown(signal).then((exitCode) => {
        process.exit(exitCode);
      });
    };

    process.once('SIGINT', () => handleSignal('SIGINT'));
    process.once('SIGTERM', () => handleSignal('SIGTERM'));
  }

  async shutdown(signal = 'MANUAL'): Promise<number> {
    if (this.isShuttingDown) return 0;
    this.isShuttingDown = true;

    logEvent('info', 'process_shutdown_started', { signal });

    // Hard emergency exit timeout in case an uncooperative connection hangs
    const forceExitTimer = setTimeout(() => {
      console.error('⚠️ [Lifecycle] Graceful shutdown timed out. Forcing process exit.');
      process.exit(1);
    }, this.timeoutMs);
    if (typeof forceExitTimer === 'object' && 'unref' in forceExitTimer) {
      forceExitTimer.unref();
    }

    try {
      for (const phase of PHASE_ORDER) {
        const phaseTasks = this.tasks.filter((t) => t.phase === phase);
        if (phaseTasks.length === 0) continue;

        console.log(`[Lifecycle] Executing phase: ${phase} (${phaseTasks.length} task(s))...`);
        await Promise.all(
          phaseTasks.map(async (task) => {
            try {
              await task.action();
            } catch (err) {
              console.warn(`⚠️ [Lifecycle] Task "${task.name}" failed during ${phase}:`, describeError(err));
            }
          })
        );
      }
      clearTimeout(forceExitTimer);
      console.log('✅ [Lifecycle] Graceful shutdown completed cleanly.');
      return 0;
    } catch (err) {
      clearTimeout(forceExitTimer);
      console.error('❌ [Lifecycle] Error during graceful shutdown:', describeError(err));
      return 1;
    }
  }

  get inShutdown(): boolean {
    return this.isShuttingDown;
  }
}

export const defaultLifecycle = new ProcessLifecycleCoordinator();
