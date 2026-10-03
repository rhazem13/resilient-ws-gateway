import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
export type Message = { type: string; instance?: string; seq?: number; cursor?: number; data?: string; time?: number };
export class Client {
  readonly socket: WebSocket;
  readonly messages: Message[] = [];
  closeCode?: number;
  handshakeStatus?: number;
  constructor(url: string, token: string) {
    this.socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 3000 });
    this.socket.on('message', raw => {
      if (this.messages.length >= 10000) { this.socket.terminate(); return; }
      this.messages.push(JSON.parse(raw.toString()) as Message);
    });
    this.socket.on('error', () => { /* Handshake rejection is observed by wait/closed. */ });
    this.socket.on('unexpected-response', (_request, response) => {
      this.handshakeStatus = response.statusCode;
      response.resume(); this.socket.terminate();
    });
    this.socket.on('close', code => { this.closeCode = code; });
  }
  async until(predicate: () => boolean, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (this.handshakeStatus) throw new Error(`Handshake rejected (${this.handshakeStatus})`);
      if (this.closeCode !== undefined) throw new Error(`Socket closed (${this.closeCode})`);
      if (Date.now() > deadline) throw new Error('Client condition timed out');
      await delay(10);
    }
  }
  async ready() { await this.until(() => this.messages.some(m => m.type === 'caught_up')); return this; }
  async event(seq: number) { await this.until(() => this.messages.some(m => m.seq === seq)); }
  async closed() { await this.until(() => this.closeCode !== undefined); return this.closeCode; }
  close() { this.socket.terminate(); }
}
export async function request(base: string, path: string, token: string | undefined, data?: unknown) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? {}), signal: AbortSignal.timeout(5000) });
}
export async function session(base: string, token: string): Promise<string> {
  const response = await request(base, '/sessions', token);
  if (response.status !== 201) throw new Error(`Session creation failed (${response.status})`);
  return (await response.json() as { id: string }).id;
}
export async function publish(base: string, id: string, token: string, data: string) {
  const response = await request(base, `/sessions/${id}/events`, token, { data });
  if (response.status !== 201) throw new Error(`Event publication failed (${response.status})`);
  return (await response.json() as { seq: number }).seq;
}
export function socketUrl(base: string, id: string, cursor = 0) { return `${base.replace('http', 'ws')}/sessions/${id}/ws?cursor=${cursor}`; }
export async function healthy(base: string) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Container may still be starting. */ }
    await delay(100);
  }
  throw new Error('Gateway did not become healthy');
}
