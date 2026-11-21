import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizedWorker, workerAuthorization } from '../netlify/lib/worker-auth.js';

test('only recent signed worker invocations authorize scheduled publishing', () => {
  process.env.SESSION_SECRET = 'worker-unit-test-secret-for-hmac-12345';
  const signed = workerAuthorization(1_800_000_000);
  const request = (authorization: string) => new Request('https://creator.example/.netlify/functions/publisher-background', { headers: { Authorization: authorization } });
  assert.equal(authorizedWorker(request(signed), 1_800_000_030), true);
  assert.equal(authorizedWorker(request(signed), 1_800_000_061), false);
  assert.equal(authorizedWorker(request(signed.slice(0, -2) + 'zz'), 1_800_000_030), false);
  assert.equal(authorizedWorker(request(''), 1_800_000_030), false);
});
