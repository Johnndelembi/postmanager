export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function json(status: number, payload: unknown, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  responseHeaders.set('Cache-Control', 'private, no-store');
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'Send JSON with Content-Type: application/json.');
  }
  const length = Number(request.headers.get('content-length') || '0');
  if (length > 64 * 1024) throw new ApiError(413, 'Request body is too large.');
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, 'Enter valid JSON.');
  }
}
