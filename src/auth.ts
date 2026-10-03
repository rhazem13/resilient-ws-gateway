import { createHmac, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function issueToken(secret: string, subject: string, lifetimeSeconds = 3600): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject, exp: Math.floor(Date.now() / 1000) + lifetimeSeconds })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

export function authenticate(header: string | undefined, secret: string): string {
  if (!header?.startsWith('Bearer ') || header.length > 2048) throw new HttpError(401, 'unauthorized');
  const parts = header.slice(7).split('.');
  const [payload, signature] = parts;
  if (parts.length !== 2 || !payload || !signature || !/^[A-Za-z0-9_-]+$/.test(signature)) throw new HttpError(401, 'unauthorized');
  const expected = createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(401, 'unauthorized');
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString()); }
  catch { throw new HttpError(401, 'unauthorized'); }
  if (!claims || typeof claims !== 'object' || !('sub' in claims) || !('exp' in claims)
    || typeof claims.sub !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(claims.sub)
    || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= Date.now() / 1000) {
    throw new HttpError(401, 'unauthorized');
  }
  return claims.sub;
}

export function parseCursor(value: string | null): number {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) throw new HttpError(400, 'invalid_cursor');
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new HttpError(400, 'invalid_cursor');
  return cursor;
}
