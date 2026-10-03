import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { HttpError } from './auth.js';

// Redis's clock and one atomic script define the ordering / expiration boundary.
const shared = `
local owner = redis.call('HGET', KEYS[1], 'owner')
if not owner then return {404} end
if owner ~= ARGV[1] then return {403} end
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local rows = redis.call('XRANGE', KEYS[2], '-', '+')
for _, row in ipairs(rows) do
  if tonumber(row[2][2]) <= now - tonumber(ARGV[2]) then redis.call('XDEL', KEYS[2], row[1]) end
end
`;
const appendScript = shared + `
local seq = redis.call('HINCRBY', KEYS[1], 'seq', 1)
redis.call('XADD', KEYS[2], 'MAXLEN', '=', ARGV[3], seq .. '-0', 'time', now, 'data', ARGV[4])
redis.call('PEXPIREAT', KEYS[2], redis.call('HGET', KEYS[1], 'expires'))
return {200, seq}
`;
const readScript = shared + `
local latest = tonumber(redis.call('HGET', KEYS[1], 'seq'))
local first = redis.call('XRANGE', KEYS[2], '-', '+', 'COUNT', 1)
local floor = latest
if #first > 0 then floor = tonumber(string.match(first[1][1], '^(%d+)')) - 1 end
local cursor = tonumber(ARGV[3])
if cursor < floor then return {409, floor, latest} end
if cursor > latest then return {400} end
return {200, latest, redis.call('XRANGE', KEYS[2], '(' .. cursor .. '-0', '+')}
`;

export type Event = { seq: number; time: number; data: string };
export class Store {
  readonly redis: Redis;
  constructor(url: string, readonly sessionMs = 600_000, readonly replayMs = 60_000, readonly maxEvents = 100) {
    this.redis = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
      connectTimeout: 1000, commandTimeout: 1000, retryStrategy: attempt => Math.min(attempt * 100, 1000) });
    this.redis.on('error', () => { /* Operations report a sanitized 503 to callers. */ });
  }
  async connect() { await this.redis.connect(); }
  keys(id: string) { return [`session:{${id}}`, `events:{${id}}`]; }
  async create(owner: string) {
    const id = randomUUID();
    const script = `local t=redis.call('TIME'); local expires=t[1]*1000+math.floor(t[2]/1000)+tonumber(ARGV[2]);
      redis.call('HSET',KEYS[1],'owner',ARGV[1],'seq',0,'expires',expires);
      redis.call('PEXPIREAT',KEYS[1],expires); return expires`;
    const expires = await this.redis.eval(script, 1, this.keys(id)[0]!, owner, this.sessionMs);
    return { id, expiresAt: Number(expires), cursor: 0 };
  }
  async append(id: string, owner: string, data: string): Promise<number> {
    const result = await this.redis.eval(appendScript, 2, ...this.keys(id), owner, this.replayMs, this.maxEvents, data) as number[];
    this.check(result[0]!);
    return result[1]!;
  }
  async read(id: string, owner: string, cursor: number): Promise<Event[]> {
    const result = await this.redis.eval(readScript, 2, ...this.keys(id), owner, this.replayMs, cursor) as [number, number, [string, string[]][]];
    this.check(result[0]);
    return result[2].map(([id, fields]) => ({ seq: Number(id.split('-')[0]), time: Number(fields[1]), data: fields[3]! }));
  }
  private check(status: number) {
    if (status !== 200) throw new HttpError(status, status === 409 ? 'replay_gap' : status === 400 ? 'cursor_ahead' : status === 403 ? 'forbidden' : 'session_expired_or_missing');
  }
  close() { this.redis.disconnect(); }
}
