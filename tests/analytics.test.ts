import assert from "node:assert/strict";
import test from "node:test";

import { getPool } from "../netlify/lib/db.js";
import { syncAnalytics, videoCounts } from "../netlify/lib/analytics.js";
import { ApiError } from "../netlify/lib/http.js";
import { encryptTikTokToken } from "../netlify/lib/tiktok.js";

process.env.DATABASE_URL = "postgresql://test:test@localhost/test";
process.env.TOKEN_ENCRYPTION_KEY = "cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=";

test("analytics requires all four real nonnegative counts and preserves zero", () => {
  assert.deepEqual(videoCounts({ view_count: 0, like_count: 0, comment_count: 0, share_count: 0 }), {
    view_count: "0", like_count: "0", comment_count: "0", share_count: "0",
  });
  assert.equal(videoCounts({ view_count: null, like_count: 0, comment_count: 0, share_count: 0 }), null);
  assert.equal(videoCounts({ view_count: true, like_count: 0, comment_count: 0, share_count: 0 }), null);
  assert.equal(videoCounts({ view_count: -1, like_count: 0, comment_count: 0, share_count: 0 }), null);
  assert.equal(videoCounts({ view_count: 1, like_count: 0, comment_count: 0 }), null);
  assert.deepEqual(videoCounts({ view_count: "9007199254740993", like_count: 1, comment_count: 2, share_count: 3 }), {
    view_count: "9007199254740993", like_count: "1", comment_count: "2", share_count: "3",
  });
});

test("analytics sync writes a snapshot only for returned videos and retains omitted video counts", async () => {
  const pool = getPool();
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const originalFetch = globalThis.fetch;
  const writes: { sql: string; values: unknown[] }[] = [];
  const account = {
    open_id: "creator", username: "Creator", granted_scopes: ["user.info.basic", "video.list"],
    refresh_expires_at: new Date(Date.now() + 86_400_000), access_expires_at: new Date(Date.now() + 600_000),
    access_token_ciphertext: encryptTikTokToken("private-access-token"),
  };
  pool.query = (async (sql: string, values: unknown[]) => {
    if (sql.startsWith("SELECT open_id")) return { rows: [account] };
    if (sql.startsWith("WITH due")) {
      assert.equal(values[0], 42);
      assert.equal(values[1], "creator");
      assert.equal(values[3], 20);
      return { rows: [
        { id: "1", user_id: "42", tiktok_post_id: "7710270777496537094", approved_tiktok_open_id: "creator" },
        { id: "2", user_id: "42", tiktok_post_id: "7710270777496537095", approved_tiktok_open_id: "creator" },
      ] };
    }
    writes.push({ sql, values });
    return { rows: [], rowCount: 1 };
  }) as unknown as typeof pool.query;
  pool.connect = (async () => ({
    query: async (sql: string) => ({ rows: sql.includes("SELECT open_id") ? [account] : [] }), release: () => {},
  })) as unknown as typeof pool.connect;
  globalThis.fetch = (async (input, init) => {
    assert.match(String(input), /\/v2\/video\/query\//);
    assert.deepEqual(JSON.parse(String(init?.body)).filters.video_ids, ["7710270777496537094", "7710270777496537095"]);
    return Response.json({ data: { videos: [{ id: "7710270777496537094", view_count: 200, like_count: 10, comment_count: 4, share_count: 2 }] }, error: { code: "ok" } });
  }) as typeof fetch;
  try {
    const result = await syncAnalytics(42, 500, true);
    assert.deepEqual(result, { checked: 2, updated: 1, unavailable: 1, cooldown: false, retry_after: 0 });
    const snapshot = writes.find(({ sql }) => sql.includes("INSERT INTO post_metric_snapshots"));
    assert.deepEqual(snapshot?.values.slice(0, 4), ["200", "10", "4", "2"]);
    const omitted = writes.find(({ sql }) => sql.includes("SET analytics_error"));
    assert.deepEqual(omitted?.values[1], ["2"]);
    assert.doesNotMatch(omitted?.sql ?? "", /view_count\s*=/);
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    globalThis.fetch = originalFetch;
  }
});

test("analytics cooldown avoids calling TikTok again", async () => {
  const pool = getPool();
  const originalQuery = pool.query;
  const originalFetch = globalThis.fetch;
  pool.query = (async (sql: string) => ({ rows: sql.startsWith("SELECT open_id") ? [{
    open_id: "creator", granted_scopes: ["video.list"], refresh_expires_at: new Date(Date.now() + 86_400_000),
  }] : [] })) as unknown as typeof pool.query;
  globalThis.fetch = (() => { throw new Error("Cooldown must not call TikTok"); }) as typeof fetch;
  try {
    const result = await syncAnalytics(42, 20, true);
    assert.equal(result.cooldown, true);
    assert.equal(result.retry_after, 60);
    assert.equal(result.checked, 0);
  } finally {
    pool.query = originalQuery;
    globalThis.fetch = originalFetch;
  }
});

test("analytics refuses synchronization without an actual video.list grant", async () => {
  const pool = getPool();
  const originalQuery = pool.query;
  pool.query = (async () => ({ rows: [{
    open_id: "creator", granted_scopes: ["user.info.basic"], refresh_expires_at: new Date(Date.now() + 86_400_000),
  }] })) as unknown as typeof pool.query;
  try {
    await assert.rejects(() => syncAnalytics(42), (error: unknown) => error instanceof ApiError && error.status === 403);
  } finally { pool.query = originalQuery; }
});
