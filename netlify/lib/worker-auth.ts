import { createHmac, timingSafeEqual } from 'node:crypto';

export function workerAuthorization(now = Math.floor(Date.now() / 1000)): string {
  const secret = process.env.SESSION_SECRET || '';
  if (Buffer.byteLength(secret) < 32) throw new Error('Worker authentication is not configured.');
  return `Bearer ${now}.${createHmac('sha256', secret).update(`publisher-worker:${now}`).digest('hex')}`;
}

export function authorizedWorker(request: Request, now = Math.floor(Date.now() / 1000)): boolean {
  const value = request.headers.get('authorization') || '';
  const match = /^Bearer (\d{10})\.([0-9a-f]{64})$/.exec(value);
  if (!match || Math.abs(now - Number(match[1])) > 60) return false;
  try {
    const expected = workerAuthorization(Number(match[1]));
    return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  } catch { return false; }
}
