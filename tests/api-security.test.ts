import {test,expect} from 'bun:test';
import {createApiServer} from '../src/server/api';

test('S02 browser cross-origin mutation from untrusted origin is rejected before any socket operation',async()=>{
 let disconnects=0;
 const app=createApiServer({
  memoryStore:{getPendingDrafts:()=>[]} as any,
  whatsappClient:{getState:()=>({state:'disconnected'}),disconnect:async()=>{disconnects++;}} as any,
  moderatorAgent:{} as any,
  sse:{broadcast:()=>{}} as any
 });
 const evil=await app.request('/api/disconnect',{method:'POST',headers:{origin:'https://malicious.example'}});
 expect(evil.status).toBe(403);
 expect(disconnects).toBe(0);
 const safe=await app.request('/api/disconnect',{method:'POST',headers:{origin:'http://localhost:5173'}});
 expect(safe.status).toBe(200);
 expect(disconnects).toBe(1);
});

test('S02 dashboard mutations accept their actual same-origin host and port', async () => {
  let disconnects = 0;
  const app = createApiServer({
    memoryStore: { getPendingDrafts: () => [] } as any,
    whatsappClient: {
      getState: () => ({ state: 'disconnected' }),
      disconnect: async () => { disconnects++; }
    } as any,
    moderatorAgent: {} as any,
    sse: { broadcast: () => {} } as any
  });
  const sameOrigin = await app.request('http://127.0.0.1:4305/api/disconnect', {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:4305' }
  });
  expect(sameOrigin.status).toBe(200);
  expect(disconnects).toBe(1);
  const foreignOrigin = await app.request('http://127.0.0.1:4305/api/disconnect', {
    method: 'POST',
    headers: { origin: 'https://unknown.example' }
  });
  expect(foreignOrigin.status).toBe(403);
  expect(disconnects).toBe(1);
});

test('GET /api/funnel/methods does not leak target credentials', async () => {
  const {FableFunnelEngine} = await import('../src/funnel/engine');
  const {FunnelRegistry} = await import('../src/funnel/registry');
  const registry = new FunnelRegistry();
  registry.registerMethod({method: 'm', targets: [{id: 't', name: 't', url: 'https://x.example', authHeader: 'Bearer SECRET-TOKEN', headers: {'x-key': 'SECRET-HDR'}, enabled: true}]} as any);
  const app = createApiServer({
    memoryStore: {getPendingDrafts: () => []} as any,
    whatsappClient: {getState: () => ({state: 'disconnected'})} as any,
    moderatorAgent: {} as any,
    sse: {broadcast: () => {}} as any,
    funnelEngine: new FableFunnelEngine({registry}),
    dashboardToken: 'owner-token-owner-token-1234'
  });
  const res = await app.request('/api/funnel/methods');
  const text = await res.text();
  expect(res.status).toBe(200);
  expect(text).not.toContain('SECRET-TOKEN');
  expect(text).not.toContain('SECRET-HDR');
  expect(JSON.parse(text).methods[0].targets[0].hasAuthHeader).toBe(true);
});

test('GET /api/funnel/methods tolerates a method registered without targets', async () => {
  const {FableFunnelEngine} = await import('../src/funnel/engine');
  const {FunnelRegistry} = await import('../src/funnel/registry');
  const registry = new FunnelRegistry();
  registry.registerMethod({method: 'bare'} as any);
  const app = createApiServer({
    memoryStore: {getPendingDrafts: () => []} as any,
    whatsappClient: {getState: () => ({state: 'disconnected'})} as any,
    moderatorAgent: {} as any,
    sse: {broadcast: () => {}} as any,
    funnelEngine: new FableFunnelEngine({registry})
  });
  const res = await app.request('/api/funnel/methods');
  expect(res.status).toBe(200);
  expect(JSON.parse(await res.text()).methods[0].targets).toEqual([]);
});
