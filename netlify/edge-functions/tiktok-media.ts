import { verifyDeliveryToken } from '../lib/delivery-token.ts';

type Environment = { get(key: string): string | undefined };
declare const Netlify: { env: Environment };

export async function serveTikTokMedia(request: Request, env: Environment): Promise<Response> {
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
  if (new URL(request.url).pathname !== '/tiktok-media/video.mp4') return new Response(null, { status: 404, headers });
  let source: URL;
  try {
    source = await verifyDeliveryToken(new URL(request.url).searchParams.get('token') || '', env.get('SESSION_SECRET') || '', env.get('NEON_STORAGE_ENDPOINT_URL_S3') || '');
  } catch {
    return new Response('Video link is invalid or expired.', { status: 403, headers });
  }
  const upstreamHeaders = new Headers();
  const range = request.headers.get('range');
  if (range) {
    if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return new Response(null, { status: 416, headers });
    upstreamHeaders.set('Range', range);
  }
  try {
    // The storage URL is signed for GET; preserve that method for HEAD probes too.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let upstream: Response;
    try {
      upstream = await fetch(source, { method: 'GET', headers: upstreamHeaders, redirect: 'manual', signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (![200, 206, 416].includes(upstream.status)) {
      await upstream.body?.cancel();
      return new Response('Video storage is unavailable.', { status: 502, headers });
    }
    const resultHeaders = new Headers(headers);
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = upstream.headers.get(key);
      if (value) resultHeaders.set(key, value);
    }
    resultHeaders.set('Content-Disposition', 'inline; filename="video.mp4"');
    if (request.method === 'HEAD') {
      await upstream.body?.cancel();
      return new Response(null, { status: upstream.status, headers: resultHeaders });
    }
    return new Response(upstream.body, { status: upstream.status, headers: resultHeaders });
  } catch {
    return new Response('Video storage is unavailable.', { status: 502, headers });
  }
}

export default (request: Request): Promise<Response> => serveTikTokMedia(request, Netlify.env);
