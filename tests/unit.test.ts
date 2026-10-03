import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, issueToken, parseCursor } from '../src/auth.js';
const secret = 'test-only-not-a-deployment-credential'.repeat(2);
test('identity comes only from a signed, unexpired subject', () => {
  const token = issueToken(secret, 'alice');
  assert.equal(authenticate(`Bearer ${token}`, secret), 'alice');
  for (const candidate of [undefined, token, `Bearer ${token}x`, `Bearer ${issueToken(secret, 'alice', -1)}`, `Bearer ${issueToken('other', 'alice')}`, `Bearer ${issueToken(secret, '')}`]) {
    assert.throws(() => authenticate(candidate, secret), /unauthorized/);
  }
});
test('cursor rejects ambiguous or unsafe numeric forms', () => {
  for (const value of [null, '', '-1', '1.5', '01', 'Infinity', '9007199254740992', '1e2']) assert.throws(() => parseCursor(value), /invalid_cursor/);
  assert.equal(parseCursor('0'), 0);
  assert.equal(parseCursor('123'), 123);
});
