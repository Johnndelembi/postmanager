import assert from "node:assert/strict";
import test from "node:test";

import { getPool } from "../netlify/lib/db.js";
import { renewSessionCookie } from "../netlify/lib/auth.js";
import { ApiError } from "../netlify/lib/http.js";
import { decryptTikTokToken, encryptTikTokToken, handleTikTok, parseTikTokJson, tikTokApi, TikTokApiError } from "../netlify/lib/tiktok.js";
import handler from "../netlify/functions/api.js";

const ORIGIN = "https://creator.example";
// Published Fernet acceptance vector: https://github.com/fernet/spec/blob/master/verify.json
const FERNET_KEY = "cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=";
const FERNET_TOKEN = "gAAAAAAdwJ6wAAECAwQFBgcICQoLDA0ODy021cpGVWKZ_eEwCGM4BLLF_5CV9dOPmrhuVUPgJobwOz7JcbmrR64jVmpU4IwqDA==";

process.env.URL = ORIGIN;
process.env.SESSION_SECRET = "test-session-secret".repeat(3);
process.env.TOKEN_ENCRYPTION_KEY = FERNET_KEY;
process.env.TIKTOK_CLIENT_KEY = "test-client-key";
process.env.TIKTOK_CLIENT_SECRET = "test-client-secret";
process.env.DATABASE_URL = "postgresql://test:test@localhost/test";
delete process.env.TIKTOK_SCOPES;

test("Netlify decrypts Python-compatible Fernet tokens and rejects tampering", () => {
  assert.equal(decryptTikTokToken(FERNET_TOKEN), "hello");
  assert.equal(decryptTikTokToken(encryptTikTokToken("private-access-token")), "private-access-token");
  const bytes = Buffer.from(FERNET_TOKEN, "base64url");
  bytes[30] ^= 1;
  const tampered = `${bytes.toString("base64url")}==`;
  assert.throws(() => decryptTikTokToken(tampered), (error: unknown) =>
    error instanceof ApiError && error.status === 503);
});

test("TikTok connect uses the HTTPS callback and binds state to the signed-in user", async () => {
  const request = new Request(`${ORIGIN}/api/tiktok/connect`);
  const response = await handleTikTok(request, 42, "/api/tiktok/connect");
  assert.equal(response?.status, 302);
  const destination = new URL(response?.headers.get("location") ?? "");
  assert.equal(destination.origin, "https://www.tiktok.com");
  assert.equal(destination.pathname, "/v2/auth/authorize/");
  assert.equal(destination.searchParams.get("redirect_uri"), `${ORIGIN}/api/tiktok/callback`);
  assert.equal(destination.searchParams.get("scope"), "user.info.basic,video.publish,video.list");
  assert.equal(destination.searchParams.get("response_type"), "code");
  const cookie = response?.headers.get("set-cookie") ?? "";
  assert.match(cookie, /HttpOnly; SameSite=Lax; Secure; Max-Age=600/);

  const state = destination.searchParams.get("state");
  const callback = `${ORIGIN}/api/tiktok/callback?code=sample&state=${state}`;
  const otherUser = new Request(callback, { headers: { Cookie: cookie.split(";")[0] } });
  await assert.rejects(() => handleTikTok(otherUser, 43, "/api/tiktok/callback"),
    (error: unknown) => error instanceof ApiError && error.status === 400);
  const wrongState = new Request(`${ORIGIN}/api/tiktok/callback?code=sample&state=short`,
    { headers: { Cookie: cookie.split(";")[0] } });
  await assert.rejects(() => handleTikTok(wrongState, 42, "/api/tiktok/callback"),
    (error: unknown) => error instanceof ApiError && error.status === 400);
  const originalNow = Date.now;
  Date.now = () => originalNow() + 601_000;
  try {
    await assert.rejects(() => handleTikTok(new Request(callback,
      { headers: { Cookie: cookie.split(";")[0] } }), 42, "/api/tiktok/callback"),
    (error: unknown) => error instanceof ApiError && error.status === 400);
  } finally {
    Date.now = originalNow;
  }
});

test("TikTok can request basic access while extra products await approval", async () => {
  process.env.TIKTOK_SCOPES = "";
  try {
    const response = await handleTikTok(new Request(`${ORIGIN}/api/tiktok/connect`), 42, "/api/tiktok/connect");
    const destination = new URL(response?.headers.get("location") ?? "");
    assert.equal(destination.searchParams.get("scope"), "user.info.basic");
  } finally {
    delete process.env.TIKTOK_SCOPES;
  }
});

test("Netlify preserves both TikTok state and session cookies on connect", async () => {
  const pool = getPool();
  const originalQuery = pool.query;
  pool.query = (async () => ({ rows: [{ id: "42", phone: "255625232734" }], rowCount: 1 })) as unknown as typeof pool.query;
  try {
    const cookie = renewSessionCookie(42, new Request(`${ORIGIN}/api/me`)).split(";")[0];
    const response = await handler(new Request(`${ORIGIN}/api/tiktok/connect`, { headers: { Cookie: cookie } }), {} as never);
    assert.equal(response.status, 302);
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.ok(cookies.some((value) => value.startsWith("postmanager_tiktok_state=")));
    assert.ok(cookies.some((value) => value.startsWith("postmanager_session=")));
  } finally {
    pool.query = originalQuery;
  }
});

test("TikTok callback exchanges the code, fetches profile, and stores encrypted tokens", async () => {
  const connect = await handleTikTok(new Request(`${ORIGIN}/api/tiktok/connect`), 42, "/api/tiktok/connect");
  const destination = new URL(connect?.headers.get("location") ?? "");
  const state = destination.searchParams.get("state");
  const cookie = (connect?.headers.get("set-cookie") ?? "").split(";")[0];
  const callback = new Request(`${ORIGIN}/api/tiktok/callback?code=sample-code&state=${state}`,
    { headers: { Cookie: cookie } });

  let stored: unknown[] | undefined;
  const pool = getPool();
  const originalQuery = pool.query;
  const originalFetch = globalThis.fetch;
  pool.query = (async (sql: string, values: unknown[]) => {
    assert.match(sql, /INSERT INTO tiktok_accounts/);
    stored = values;
    return { rows: [], rowCount: 1 };
  }) as typeof pool.query;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/v2/oauth/token/")) {
      const body = init?.body as URLSearchParams;
      assert.equal(body.get("code"), "sample-code");
      assert.equal(body.get("redirect_uri"), `${ORIGIN}/api/tiktok/callback`);
      assert.equal(body.get("client_secret"), "test-client-secret");
      return Response.json({
        access_token: "private-access-token",
        refresh_token: "private-refresh-token",
        open_id: "tiktok-open-id",
        scope: "user.info.basic",
        expires_in: 7200,
        refresh_expires_in: 15_552_000,
      });
    }
    assert.match(String(input), /\/v2\/user\/info\/\?/);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-access-token");
    return Response.json({ data: { user: { open_id: "tiktok-open-id", display_name: "Creator" } }, error: { code: "ok" } });
  }) as typeof fetch;
  try {
    const response = await handleTikTok(callback, 42, "/api/tiktok/callback");
    assert.equal(response?.status, 302);
    assert.equal(response?.headers.get("location"), `${ORIGIN}/?tiktok=connected`);
    assert.match(response?.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal(stored?.[0], 42);
    assert.equal(stored?.[1], "tiktok-open-id");
    assert.equal(stored?.[2], "Creator");
    assert.equal(decryptTikTokToken(String(stored?.[3])), "private-access-token");
    assert.equal(decryptTikTokToken(String(stored?.[4])), "private-refresh-token");
    assert.ok(stored?.[5] instanceof Date);
    assert.ok(stored?.[6] instanceof Date);
    assert.deepEqual(stored?.[7], ["user.info.basic"]);
  } finally {
    pool.query = originalQuery;
    globalThis.fetch = originalFetch;
  }
});

test("TikTok numeric int64 IDs retain every digit without changing text fields", () => {
  const result = parseTikTokJson('{"data":{"publicaly_available_post_id":[7710270777496537094],"view_count":42,"title":"7710270777496537094, id 123"}}');
  assert.deepEqual(result, { data: { publicaly_available_post_id: ["7710270777496537094"], view_count: 42, title: "7710270777496537094, id 123" } });
});

test("TikTok API refuses a changed account before sending a publish request", async () => {
  const pool = getPool();
  const originalConnect = pool.connect;
  const originalFetch = globalThis.fetch;
  const commands: string[] = [];
  pool.connect = (async () => ({
    query: async (sql: string) => {
      commands.push(sql);
      return { rows: sql.includes("SELECT open_id") ? [{ open_id: "new-account", granted_scopes: ["video.publish"] }] : [] };
    },
    release: () => {},
  })) as unknown as typeof pool.connect;
  globalThis.fetch = (() => { throw new Error("Changed account must not call TikTok"); }) as typeof fetch;
  try {
    await assert.rejects(() => tikTokApi(42, "/v2/post/publish/video/init/", {}, "POST", "approved-account"),
      (error: unknown) => error instanceof ApiError && error.status === 409);
    assert.ok(commands.includes("ROLLBACK"));
  } finally {
    pool.connect = originalConnect;
    globalThis.fetch = originalFetch;
  }
});

test("TikTok API labels a lost init response as uncertain", async () => {
  const pool = getPool();
  const originalConnect = pool.connect;
  const originalFetch = globalThis.fetch;
  pool.connect = (async () => ({
    query: async (sql: string) => ({ rows: sql.includes("SELECT open_id") ? [{
      open_id: "approved-account", granted_scopes: ["video.publish"],
      access_token_ciphertext: encryptTikTokToken("access"), access_expires_at: new Date(Date.now() + 600_000),
    }] : [] }),
    release: () => {},
  })) as unknown as typeof pool.connect;
  globalThis.fetch = (async () => { throw new Error("Socket closed"); }) as typeof fetch;
  try {
    await assert.rejects(() => tikTokApi(42, "/v2/post/publish/video/init/", {}, "POST", "approved-account"),
      (error: unknown) => error instanceof TikTokApiError && error.uncertain && error.status === 503);
  } finally {
    pool.connect = originalConnect;
    globalThis.fetch = originalFetch;
  }
});

test("TikTok refresh persists rotated tokens and reduced grants before refusing an operation", async () => {
  const pool = getPool();
  const originalConnect = pool.connect;
  const originalFetch = globalThis.fetch;
  const commands: { sql: string; values?: unknown[] }[] = [];
  pool.connect = (async () => ({
    query: async (sql: string, values?: unknown[]) => {
      commands.push({ sql, values });
      return { rows: sql.includes("SELECT open_id") ? [{
        open_id: "creator", granted_scopes: ["user.info.basic", "video.list"],
        access_expires_at: new Date(0), refresh_expires_at: new Date(Date.now() + 86_400_000),
        refresh_token_ciphertext: encryptTikTokToken("old-refresh-token"),
      }] : [] };
    }, release: () => {},
  })) as unknown as typeof pool.connect;
  let requests = 0;
  globalThis.fetch = (async (input, init) => {
    requests += 1;
    assert.match(String(input), /\/v2\/oauth\/token\/$/);
    assert.equal((init?.body as URLSearchParams).get("refresh_token"), "old-refresh-token");
    return Response.json({ access_token: "new-access-token", refresh_token: "rotated-refresh-token", open_id: "creator",
      scope: "user.info.basic", expires_in: 7200, refresh_expires_in: 15_552_000 });
  }) as typeof fetch;
  try {
    await assert.rejects(() => tikTokApi(42, "/v2/video/query/", {}, "POST", "creator"),
      (error: unknown) => error instanceof ApiError && error.status === 403);
    assert.equal(requests, 1);
    const update = commands.find(({ sql }) => sql.startsWith("UPDATE tiktok_accounts"));
    assert.deepEqual(update?.values?.[4], ["user.info.basic"]);
    assert.equal(decryptTikTokToken(String(update?.values?.[1])), "rotated-refresh-token");
    assert.ok(commands.some(({ sql }) => sql === "COMMIT"));
    assert.ok(!commands.some(({ sql }) => sql === "ROLLBACK"));
  } finally {
    pool.connect = originalConnect;
    globalThis.fetch = originalFetch;
  }
});
