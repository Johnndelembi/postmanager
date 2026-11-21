import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getPool } from "./db.js";
import { ApiError, json } from "./http.js";
import { deliveryConfigured } from "./delivery.js";

const API_BASE = "https://open.tiktokapis.com";
const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const OPTIONAL_SCOPES = new Set(["video.publish", "video.list"]);
const STATE_COOKIE = "postmanager_tiktok_state";
const STATE_SECONDS = 600;

type TokenSet = {
  access_token: string;
  refresh_token: string;
  open_id: string;
  scope: string;
  expires_in: number;
  refresh_expires_in: number;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ApiError(503, `${name} is not configured.`);
  return value;
}

function requestedScopes(): string[] {
  const optional = (process.env.TIKTOK_SCOPES ?? "video.publish,video.list").split(",").map((scope) => scope.trim()).filter(Boolean);
  if (optional.some((scope) => !OPTIONAL_SCOPES.has(scope))) {
    throw new ApiError(503, "TIKTOK_SCOPES may contain only video.publish and video.list.");
  }
  return ["user.info.basic", ...new Set(optional)];
}

function encryptionKey(): Buffer {
  const value = requiredEnv("TOKEN_ENCRYPTION_KEY");
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || value !== `${key.toString("base64url")}=`) {
    throw new ApiError(503, "TOKEN_ENCRYPTION_KEY must be a Fernet key.");
  }
  return key;
}

function sessionSecret(): string {
  const value = requiredEnv("SESSION_SECRET");
  if (Buffer.byteLength(value) < 32) throw new ApiError(503, "SESSION_SECRET must be at least 32 bytes.");
  return value;
}

function paddedBase64url(bytes: Buffer): string {
  const unpadded = bytes.toString("base64url");
  return unpadded + "=".repeat((4 - unpadded.length % 4) % 4);
}

// Fernet is also used by postmanager/accounts.py, so either runtime can read stored tokens.
export function encryptTikTokToken(value: string): string {
  const key = encryptionKey();
  const iv = randomBytes(16);
  const header = Buffer.alloc(9);
  header[0] = 0x80;
  header.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)), 1);
  const cipher = createCipheriv("aes-128-cbc", key.subarray(16), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const signed = Buffer.concat([header, iv, ciphertext]);
  const mac = createHmac("sha256", key.subarray(0, 16)).update(signed).digest();
  return paddedBase64url(Buffer.concat([signed, mac]));
}

export function decryptTikTokToken(value: string): string {
  const key = encryptionKey();
  const invalid = new ApiError(503, "Stored TikTok credentials could not be decrypted. Check TOKEN_ENCRYPTION_KEY.");
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value) || value.length > 16_384) throw invalid;
  const token = Buffer.from(value, "base64url");
  if (token.length < 73 || token[0] !== 0x80 || paddedBase64url(token) !== value) throw invalid;
  const signed = token.subarray(0, -32);
  const suppliedMac = token.subarray(-32);
  const expectedMac = createHmac("sha256", key.subarray(0, 16)).update(signed).digest();
  if (!timingSafeEqual(suppliedMac, expectedMac)) throw invalid;
  try {
    const iv = token.subarray(9, 25);
    const ciphertext = token.subarray(25, -32);
    const decipher = createDecipheriv("aes-128-cbc", key.subarray(16), iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw invalid;
  }
}

function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.port) {
    throw new ApiError(503, "TikTok Login Kit requires a public HTTPS URL.");
  }
  // Netlify supplies URL for the site's canonical origin. Reject a forged Host when present.
  if (process.env.URL) {
    let expected: URL;
    try {
      expected = new URL(process.env.URL);
    } catch {
      throw new ApiError(503, "Netlify URL is invalid.");
    }
    if (expected.protocol !== "https:" || expected.origin !== url.origin) {
      throw new ApiError(403, "Use the site's registered HTTPS address to connect TikTok.");
    }
  }
  return url.origin;
}

function callbackUrl(request: Request): string {
  return `${publicOrigin(request)}/api/tiktok/callback`;
}

function stateSignature(marker: string): string {
  return createHmac("sha256", sessionSecret()).update(`tiktok-state:${marker}`).digest("hex");
}

function stateCookie(value: string, maxAge = STATE_SECONDS): string {
  return `${STATE_COOKIE}=${value}; Path=/api/tiktok; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
}

function cookieValue(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === STATE_COOKIE) return value.join("=");
  }
  return null;
}

function verifyState(request: Request, userId: number, returnedState: string): void {
  const raw = cookieValue(request);
  const parts = raw?.split(".") ?? [];
  if (parts.length !== 4 || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]) ||
      !/^[0-9a-f]{64}$/.test(parts[3]) || !/^[A-Za-z0-9_-]{43}$/.test(returnedState)) {
    throw new ApiError(400, "TikTok authorization state is invalid or expired.");
  }
  const [owner, state, expiry, signature] = parts;
  const marker = `${owner}.${state}.${expiry}`;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Number(expiry);
  const expected = stateSignature(marker);
  if (owner !== String(userId) || !Number.isSafeInteger(expiresAt) || expiresAt < now ||
      expiresAt > now + STATE_SECONDS ||
      !timingSafeEqual(Buffer.from(signature, "ascii"), Buffer.from(expected, "ascii")) ||
      !timingSafeEqual(Buffer.from(state, "ascii"), Buffer.from(returnedState, "ascii"))) {
    throw new ApiError(400, "TikTok authorization state is invalid or expired.");
  }
}

function redirect(location: string, cookie: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Set-Cookie": cookie, "Cache-Control": "private, no-store" },
  });
}

function configured(request: Request): boolean {
  try {
    callbackUrl(request);
    requiredEnv("TIKTOK_CLIENT_KEY");
    requiredEnv("TIKTOK_CLIENT_SECRET");
    encryptionKey();
    sessionSecret();
    requestedScopes();
    return true;
  } catch (error) {
    if (error instanceof ApiError) return false;
    throw error;
  }
}

function validSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function tokenSet(value: Record<string, unknown>): TokenSet {
  const { access_token, refresh_token, open_id, scope, expires_in, refresh_expires_in } = value;
  if (typeof access_token !== "string" || !access_token ||
      typeof refresh_token !== "string" || !refresh_token ||
      typeof open_id !== "string" || !open_id ||
      typeof scope !== "string" ||
      !validSeconds(expires_in) || !validSeconds(refresh_expires_in)) {
    throw new ApiError(502, "TikTok returned incomplete account credentials.");
  }
  return { access_token, refresh_token, open_id, scope, expires_in, refresh_expires_in };
}

function errorStatus(code: string, httpStatus: number): number {
  if (["rate_limit_exceeded", "spam_risk_too_many_posts", "reached_active_user_cap"].includes(code)) return 429;
  if (code === "access_token_invalid" || code === "invalid_grant") return 401;
  if (code === "scope_not_authorized" || code === "unauthorized_client") return 403;
  if (["invalid_param", "privacy_level_option_mismatch", "invalid_request"].includes(code)) return 400;
  if (httpStatus >= 400 && httpStatus < 500) return httpStatus;
  return 502;
}

export class TikTokApiError extends ApiError {
  constructor(readonly code: string, message: string, status = 502, readonly uncertain = false) {
    super(status, message);
    this.name = "TikTokApiError";
  }
}

export function parseTikTokJson(raw: string): unknown {
  // TikTok status responses can contain numeric int64 post IDs beyond JavaScript's safe range.
  const preserved = raw.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) =>
    /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token);
  return JSON.parse(preserved);
}

async function tikTokRequest(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new TikTokApiError("network_error", "TikTok could not be reached right now.", 503, true);
  }
  let data: unknown;
  try {
    data = parseTikTokJson(await response.text());
  } catch {
    throw new TikTokApiError("invalid_response", "TikTok returned an unreadable response.", 502, true);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new TikTokApiError("invalid_response", "TikTok returned an unexpected response.", 502, true);
  }
  const result = data as Record<string, unknown>;
  const error = result.error;
  const code = typeof error === "string" ? error :
    error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if ((code && code !== "ok") || !response.ok) {
    throw new TikTokApiError(code || "http_error", code ? `TikTok rejected the request (${code}).` : "TikTok rejected the request.",
      errorStatus(code, response.status), response.status >= 500 || code === "internal_error");
  }
  return result;
}

async function exchangeCode(code: string, callback: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_key: requiredEnv("TIKTOK_CLIENT_KEY"),
    client_secret: requiredEnv("TIKTOK_CLIENT_SECRET"),
    code,
    grant_type: "authorization_code",
    redirect_uri: callback,
  });
  return tokenSet(await tikTokRequest("/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body,
  }));
}

async function refreshToken(value: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_key: requiredEnv("TIKTOK_CLIENT_KEY"),
    client_secret: requiredEnv("TIKTOK_CLIENT_SECRET"),
    grant_type: "refresh_token",
    refresh_token: value,
  });
  return tokenSet(await tikTokRequest("/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body,
  }));
}

async function userInfo(accessToken: string): Promise<{ open_id: string; display_name?: string }> {
  const result = await tikTokRequest("/v2/user/info/?fields=open_id,display_name,avatar_url", {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = result.data;
  const user = data && typeof data === "object" && "user" in data ? data.user : null;
  if (!user || typeof user !== "object" || !("open_id" in user) || typeof user.open_id !== "string") {
    throw new ApiError(502, "TikTok returned no user profile.");
  }
  return user as { open_id: string; display_name?: string };
}

async function saveAccount(userId: number, tokens: TokenSet, profile: { open_id: string; display_name?: string }): Promise<void> {
  if (profile.open_id !== tokens.open_id) throw new ApiError(502, "TikTok returned inconsistent account details.");
  const now = Date.now();
  try {
    await getPool().query(
      `INSERT INTO tiktok_accounts
         (user_id, open_id, username, access_token_ciphertext, refresh_token_ciphertext,
          access_expires_at, refresh_expires_at, granted_scopes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id) DO UPDATE SET
         open_id = EXCLUDED.open_id, username = EXCLUDED.username,
         access_token_ciphertext = EXCLUDED.access_token_ciphertext,
         refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
         access_expires_at = EXCLUDED.access_expires_at,
         refresh_expires_at = EXCLUDED.refresh_expires_at,
         granted_scopes = EXCLUDED.granted_scopes, updated_at = now()`,
      [userId, tokens.open_id, profile.display_name || null,
        encryptTikTokToken(tokens.access_token), encryptTikTokToken(tokens.refresh_token),
        new Date(now + tokens.expires_in * 1000), new Date(now + tokens.refresh_expires_in * 1000), parseScopes(tokens.scope)],
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      throw new ApiError(409, "This TikTok account is already connected to another user.");
    }
    throw error;
  }
}

function parseScopes(value: string): string[] {
  return [...new Set(value.split(",").map((scope) => scope.trim()).filter(Boolean))];
}

export type TikTokAccount = {
  connected: boolean;
  open_id: string | null;
  username: string | null;
  scopes: string[];
  authorization_expired: boolean;
};

export async function getTikTokAccount(userId: number): Promise<TikTokAccount> {
  const result = await getPool().query<{
    open_id: string; username: string | null; granted_scopes: string[]; refresh_expires_at: Date;
  }>("SELECT open_id, username, granted_scopes, refresh_expires_at FROM tiktok_accounts WHERE user_id = $1", [userId]);
  const account = result.rows[0];
  return {
    connected: Boolean(account), open_id: account?.open_id ?? null, username: account?.username ?? null,
    scopes: account?.granted_scopes ?? [],
    authorization_expired: Boolean(account && new Date(account.refresh_expires_at).getTime() <= Date.now()),
  };
}

async function accessToken(userId: number, scope?: string, expectedOpenId?: string): Promise<string> {
  const client = await getPool().connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      open_id: string; access_token_ciphertext: string; refresh_token_ciphertext: string;
      access_expires_at: Date; refresh_expires_at: Date; granted_scopes: string[];
    }>(
      `SELECT open_id, access_token_ciphertext, refresh_token_ciphertext,
              access_expires_at, refresh_expires_at, granted_scopes
         FROM tiktok_accounts WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const account = result.rows[0];
    if (!account) throw new ApiError(409, "Connect a TikTok account first.");
    if (expectedOpenId && account.open_id !== expectedOpenId) {
      throw new ApiError(409, "The connected TikTok account changed. Review the post for this account before publishing.");
    }
    if (scope && !account.granted_scopes?.includes(scope)) {
      throw new ApiError(403, `Reconnect TikTok and authorize ${scope} access first.`);
    }
    if (new Date(account.access_expires_at).getTime() > Date.now() + 120_000) {
      const token = decryptTikTokToken(account.access_token_ciphertext);
      await client.query("COMMIT");
      committed = true;
      return token;
    }
    if (new Date(account.refresh_expires_at).getTime() <= Date.now()) {
      throw new ApiError(401, "TikTok authorization expired. Reconnect the account.");
    }
    const tokens = await refreshToken(decryptTikTokToken(account.refresh_token_ciphertext));
    if (tokens.open_id !== account.open_id) throw new ApiError(502, "TikTok refreshed a different account.");
    const now = Date.now();
    await client.query(
      `UPDATE tiktok_accounts SET access_token_ciphertext = $1, refresh_token_ciphertext = $2,
         access_expires_at = $3, refresh_expires_at = $4, granted_scopes = $5, updated_at = now() WHERE user_id = $6`,
      [encryptTikTokToken(tokens.access_token), encryptTikTokToken(tokens.refresh_token),
        new Date(now + tokens.expires_in * 1000), new Date(now + tokens.refresh_expires_in * 1000), parseScopes(tokens.scope), userId],
    );
    await client.query("COMMIT");
    committed = true;
    if (scope && !parseScopes(tokens.scope).includes(scope)) {
      throw new ApiError(403, `TikTok no longer grants ${scope} access. Reconnect the account.`);
    }
    return tokens.access_token;
  } catch (error) {
    if (!committed) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function tikTokApi(userId: number, path: string, payload?: Record<string, unknown>, method = "POST", expectedOpenId?: string): Promise<Record<string, unknown>> {
  const scope = path.startsWith("/v2/post/publish/") ? "video.publish" : path.startsWith("/v2/video/") ? "video.list" : undefined;
  const token = await accessToken(userId, scope, expectedOpenId);
  const result = await tikTokRequest(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    throw new TikTokApiError("invalid_response", "TikTok returned no data.", 502, true);
  }
  return result.data as Record<string, unknown>;
}

export async function creatorInfo(userId: number, expectedOpenId?: string): Promise<Record<string, unknown>> {
  return tikTokApi(userId, "/v2/post/publish/creator_info/query/", undefined, "POST", expectedOpenId);
}

export async function handleTikTok(request: Request, userId: number, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/tiktok/")) return null;
  if (!["/api/tiktok/status", "/api/tiktok/connect", "/api/tiktok/callback", "/api/tiktok/creator-info"].includes(pathname)) {
    return null;
  }
  if (request.method !== "GET") throw new ApiError(405, "Method not allowed.");

  if (pathname === "/api/tiktok/status") {
    const account = await getTikTokAccount(userId);
    const connected = account.connected;
    const https = new URL(request.url).protocol === "https:";
    const ready = configured(request);
    const creatorInfoReady = ready && connected && !account.authorization_expired && account.scopes.includes("video.publish");
    const analyticsReady = ready && connected && !account.authorization_expired && account.scopes.includes("video.list");
    return json(200, {
      connected,
      username: account.username,
      scopes: account.scopes,
      configured: ready,
      publishing_ready: creatorInfoReady && deliveryConfigured(),
      creator_info_ready: creatorInfoReady,
      analytics_ready: analyticsReady,
      reconnect_required: connected && (account.authorization_expired || (ready && requestedScopes().some((scope) => !account.scopes.includes(scope)))),
      audited: process.env.TIKTOK_APP_AUDITED === "1",
      setup_stage: !https ? "awaiting_https" : !ready ? "configure_tiktok" : !connected ? "connect_tiktok" : "connected",
    });
  }

  if (pathname === "/api/tiktok/connect") {
    const callback = callbackUrl(request);
    requiredEnv("TIKTOK_CLIENT_SECRET");
    encryptionKey();
    const state = randomBytes(32).toString("base64url");
    const marker = `${userId}.${state}.${Math.floor(Date.now() / 1000) + STATE_SECONDS}`;
    const destination = new URL(AUTHORIZE_URL);
    destination.search = new URLSearchParams({
      client_key: requiredEnv("TIKTOK_CLIENT_KEY"),
      response_type: "code",
      scope: requestedScopes().join(","),
      redirect_uri: callback,
      state,
    }).toString();
    return redirect(destination.toString(), stateCookie(`${marker}.${stateSignature(marker)}`));
  }

  if (pathname === "/api/tiktok/callback") {
    const url = new URL(request.url);
    if (url.searchParams.has("error")) throw new ApiError(400, "TikTok authorization was cancelled or denied.");
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    verifyState(request, userId, state);
    if (!code) throw new ApiError(400, "TikTok returned no authorization code.");
    const tokens = await exchangeCode(code, callbackUrl(request));
    const granted = new Set(tokens.scope.split(",").map((scope) => scope.trim()));
    if (!granted.has("user.info.basic")) {
      throw new ApiError(403, "Authorize basic profile access to connect TikTok.");
    }
    await saveAccount(userId, tokens, await userInfo(tokens.access_token));
    return redirect(`${publicOrigin(request)}/?tiktok=connected`, stateCookie("", 0));
  }

  if (!configured(request)) throw new ApiError(503, "TikTok Login Kit is not configured.");
  const account = await getTikTokAccount(userId);
  if (!account.open_id) throw new ApiError(409, 'Connect a TikTok account first.');
  return json(200, { ...await creatorInfo(userId, account.open_id), account_open_id: account.open_id });
}
