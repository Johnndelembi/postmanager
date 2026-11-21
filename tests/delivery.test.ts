import assert from 'node:assert/strict';
import test from 'node:test';
import { signDeliveryToken, verifyDeliveryToken } from '../netlify/lib/delivery-token.js';
import { serveTikTokMedia } from '../netlify/edge-functions/tiktok-media.js';

const secret = 'a-test-secret-for-delivery-only-12345';
const endpoint = 'https://storage.example/s3';
const source = `${endpoint}/videos/users/42/${'a'.repeat(32)}.mp4?signature=test`;
const env = { get: (key: string) => ({ SESSION_SECRET: secret, NEON_STORAGE_ENDPOINT_URL_S3: endpoint })[key as 'SESSION_SECRET'] };

test('delivery capabilities reject tampering, expiry, and another source host or object', async () => {
  const token = await signDeliveryToken(source, secret, 1000);
  assert.equal((await verifyDeliveryToken(token, secret, endpoint, 1001)).href, source);
  await assert.rejects(verifyDeliveryToken(token.slice(0, -8) + 'modified', secret, endpoint, 1001));
  await assert.rejects(verifyDeliveryToken(token, secret, endpoint, 8201));
  await assert.rejects(verifyDeliveryToken(await signDeliveryToken('https://other.example/videos/users/42/a.mp4', secret, 1000), secret, endpoint, 1001));
  await assert.rejects(verifyDeliveryToken(await signDeliveryToken(`${endpoint}/videos/private.txt`, secret, 1000), secret, endpoint, 1001));
});

test('delivery proxies byte ranges without redirects, cookies, or buffering the video', async () => {
  const originalFetch = globalThis.fetch;
  const token = await signDeliveryToken(source, secret);
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), source);
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('range'), 'bytes=0-7');
    assert.equal(new Headers(init?.headers).get('cookie'), null);
    return new Response('mp4bytes', { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-7/100' } });
  }) as typeof fetch;
  try {
    const response = await serveTikTokMedia(new Request(`https://creator.example/tiktok-media/video.mp4?token=${token}`, { headers: { Range: 'bytes=0-7', Cookie: 'private=value' } }), env);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 0-7/100');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(await response.text(), 'mp4bytes');
    globalThis.fetch = (async () => new Response(null, { status: 302, headers: { Location: 'https://other.example/' } })) as typeof fetch;
    assert.equal((await serveTikTokMedia(new Request(`https://creator.example/tiktok-media/video.mp4?token=${token}`), env)).status, 502);
    assert.equal((await serveTikTokMedia(new Request('https://creator.example/tiktok-media/video.mp4'), env)).status, 403);
  } finally { globalThis.fetch = originalFetch; }
});
