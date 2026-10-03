import Fastify from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { authenticate, HttpError, parseCursor } from './auth.js';
import { Store, type Event } from './store.js';
import { metrics } from './metrics.js';

export type Config = { port: number; instance: string; redisUrl: string; secret: string; sessionMs?: number; replayMs?: number; maxEvents?: number };
const MAX_BUFFER = 64 * 1024;

export async function startGateway(config: Config) {
  if (config.secret.length < 32) throw new Error('AUTH_SECRET must be at least 32 characters');
  const app = Fastify({ logger: false, bodyLimit: 8192 });
  const store = new Store(config.redisUrl, config.sessionMs, config.replayMs, config.maxEvents);
  const stats = metrics();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  let closing = false;
  await store.connect();
  const owner = (header: string | undefined) => authenticate(header, config.secret);
  async function operation<T>(action: () => Promise<T>): Promise<T> {
    const stop = stats.redisDuration.startTimer();
    try { return await action(); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'state_unavailable'); }
    finally { stop(); }
  }
  app.setErrorHandler((error, _request, reply) => {
    const frameworkStatus = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    const status = error instanceof HttpError ? error.status : frameworkStatus < 500 ? frameworkStatus : 500;
    reply.code(status).send({ error: error instanceof HttpError ? error.message : status < 500 ? 'invalid_request' : 'internal_error' });
  });
  app.addHook('onRequest', async (_request, reply) => { if (closing) await reply.code(503).send({ error: 'shutting_down' }); });
  app.get('/health', async () => { await operation(() => store.redis.ping()); return { instance: config.instance }; });
  app.get('/metrics', async (_request, reply) => reply.type(stats.registry.contentType).send(await stats.registry.metrics()));
  app.post('/sessions', async (request, reply) => reply.code(201).send(await operation(() => store.create(owner(request.headers.authorization)))));
  app.post<{ Params: { id: string }; Body: unknown }>('/sessions/:id/events', async (request, reply) => {
    const subject = owner(request.headers.authorization);
    const id = validId(request.params.id);
    const body = request.body;
    if (!body || typeof body !== 'object' || !('data' in body) || typeof body.data !== 'string' || Buffer.byteLength(body.data) > 4096) throw new HttpError(400, 'invalid_event');
    const data = body.data;
    const seq = await operation(() => store.append(id, subject, data));
    return reply.code(201).send({ seq });
  });
  function stopSocket(socket: WebSocket, code: number, reason: string) {
    stats.failures.inc({ reason });
    socket.close(code, reason);
    const timeout = setTimeout(() => socket.terminate(), 500);
    timeout.unref();
    socket.once('close', () => clearTimeout(timeout));
  }
  function send(socket: WebSocket, value: object): boolean {
    const message = JSON.stringify(value);
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount + Buffer.byteLength(message) > MAX_BUFFER) { stopSocket(socket, 4008, 'slow_consumer'); return false; }
    socket.send(message, error => { if (error) socket.terminate(); });
    return true;
  }
  async function follow(socket: WebSocket, id: string, subject: string, cursor: number, initial: Event[], expires: number) {
    let batch = initial;
    let replay = true;
    let lastPing = Date.now(), alive = true;
    socket.on('pong', () => { alive = true; });
    while (socket.readyState === WebSocket.OPEN && !closing) {
      if (Date.now() >= expires * 1000) { stopSocket(socket, 4001, 'token_expired'); return; }
      if (Date.now() - lastPing >= 20_000) {
        if (!alive) { stopSocket(socket, 1001, 'heartbeat_timeout'); return; }
        alive = false; lastPing = Date.now(); socket.ping();
      }
      for (const event of batch) {
        if (!send(socket, { type: 'event', ...event })) return;
        cursor = event.seq;
        if (replay) stats.replayed.inc();
      }
      if (replay && !send(socket, { type: 'caught_up', cursor })) return;
      replay = false;
      await delay(50);
      if (socket.readyState !== WebSocket.OPEN || closing) return;
      try { batch = await operation(() => store.read(id, subject, cursor)); }
      catch (error) {
        const reason = error instanceof HttpError ? error.message : 'state_unavailable';
        stopSocket(socket, reason === 'replay_gap' ? 4009 : reason === 'session_expired_or_missing' ? 4004 : 1013, reason);
        return;
      }
    }
  }
  app.server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy());
    void (async () => {
      if (closing || sockets.clients.size >= 1000) throw new HttpError(503, 'capacity_or_shutdown');
      const subject = owner(request.headers.authorization);
      const url = new URL(request.url ?? '/', 'http://localhost');
      const match = /^\/sessions\/([^/]+)\/ws$/.exec(url.pathname);
      if (!match) throw new HttpError(404, 'not_found');
      const id = validId(match[1]!);
      const cursor = parseCursor(url.searchParams.get('cursor'));
      const initial = await operation(() => store.read(id, subject, cursor));
      // Revalidate after I/O: shutdown or authentication expiry may happen during Redis access.
      owner(request.headers.authorization);
      if (closing || sockets.clients.size >= 1000) throw new HttpError(503, 'capacity_or_shutdown');
      sockets.handleUpgrade(request, socket, head, ws => {
        stats.connections.inc(); stats.accepted.inc();
        ws.on('error', () => ws.terminate());
        ws.once('close', () => stats.connections.dec());
        ws.on('message', () => stopSocket(ws, 1008, 'receive_only'));
        send(ws, { type: 'ready', instance: config.instance });
        const payload = request.headers.authorization!.slice(7).split('.')[0]!;
        const expires = (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp: number }).exp;
        void follow(ws, id, subject, cursor, initial, expires);
      });
    })().catch(error => {
      const status = error instanceof HttpError ? error.status : 503;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
  });
  await app.listen({ port: config.port, host: '0.0.0.0' });
  return { app, store, async close() {
    closing = true;
    for (const ws of sockets.clients) stopSocket(ws, 1012, 'service_restart');
    await app.close();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    store.close(); stats.registry.clear();
  } };
}

function validId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new HttpError(400, 'invalid_session');
  return id;
}
