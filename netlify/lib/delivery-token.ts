const encoder = new TextEncoder();
export const DELIVERY_SECONDS = 2 * 60 * 60;

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid token');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), (c) => c.charCodeAt(0));
}

async function signingKey(secret: string): Promise<CryptoKey> {
  if (encoder.encode(secret).length < 32) throw new Error('Delivery signing is not configured');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signDeliveryToken(url: string, secret: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const payload = encode(encoder.encode(JSON.stringify({ url, expires: now + DELIVERY_SECONDS })));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(`tiktok-delivery:${payload}`));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}

export async function verifyDeliveryToken(token: string, secret: string, endpoint: string, now = Math.floor(Date.now() / 1000)): Promise<URL> {
  if (token.length > 8192) throw new Error('Invalid token');
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) throw new Error('Invalid token');
  if (!(await crypto.subtle.verify('HMAC', await signingKey(secret), decode(signature), encoder.encode(`tiktok-delivery:${payload}`)))) {
    throw new Error('Invalid token');
  }
  const claim = JSON.parse(new TextDecoder().decode(decode(payload)));
  if (!Number.isSafeInteger(claim.expires) || claim.expires <= now || claim.expires > now + DELIVERY_SECONDS || typeof claim.url !== 'string') {
    throw new Error('Expired token');
  }
  const url = new URL(claim.url);
  const allowed = new URL(endpoint);
  const prefix = allowed.pathname.replace(/\/$/, '') + '/videos/';
  if (allowed.protocol !== 'https:' || url.protocol !== 'https:' || url.origin !== allowed.origin || url.username || url.password ||
      !url.pathname.startsWith(prefix) || !/^users\/[1-9][0-9]*\/[a-f0-9]{32}\.mp4$/.test(url.pathname.slice(prefix.length))) {
    throw new Error('Invalid storage source');
  }
  return url;
}
