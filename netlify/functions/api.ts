import type { Context } from '@netlify/functions';
import { getAuthenticatedUser, handleAuth, renewSessionCookie } from '../lib/auth.js';
import { getPool } from '../lib/db.js';
import { ApiError, json } from '../lib/http.js';
import { handleMedia } from '../lib/media.js';
import { handlePlanner } from '../lib/posts.js';
import { handleTikTok } from '../lib/tiktok.js';
import { handleAnalytics } from '../lib/analytics.js';

function normalizeRequest(request: Request): { request: Request; path: string } {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/\.netlify\/functions\/api(?=\/|$)/, '/api');
  if (path === url.pathname) return { request, path };
  url.pathname = path;
  return { request: new Request(url, request), path };
}

function checkOrigin(request: Request): void {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const origin = request.headers.get('origin');
  if (origin !== new URL(request.url).origin) {
    throw new ApiError(403, 'This request must come from this site.');
  }
}

function withRenewedSession(response: Response, userId: number, request: Request): Response {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', renewSessionCookie(userId, request));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default async function handler(incoming: Request, _context: Context): Promise<Response> {
  const { request, path } = normalizeRequest(incoming);
  try {
    checkOrigin(request);
    if (path === '/api/health' && request.method === 'GET') {
      await getPool().query('SELECT 1');
      return json(200, { ok: true });
    }

    const auth = await handleAuth(request, path);
    if (auth) return auth;

    const user = await getAuthenticatedUser(request);
    let response: Response | null = await handleMedia(request, user.id, path);
    if (!response) response = await handleTikTok(request, user.id, path);
    if (!response) response = await handleAnalytics(request, user.id, path);
    if (!response) response = await handlePlanner(request, user.id);
    return withRenewedSession(response, user.id, request);
  } catch (error) {
    if (error instanceof ApiError) {
      const headers = error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : undefined;
      return json(error.status, { error: error.message }, headers);
    }
    console.error('Postmanager API request failed:', error instanceof Error ? error.message : String(error));
    return json(500, { error: 'The server could not complete this request. Try again.' });
  }
}
