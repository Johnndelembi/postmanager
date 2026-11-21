import assert from "node:assert/strict";
import test from "node:test";

import { getPool } from "../netlify/lib/db.js";
import { ApiError } from "../netlify/lib/http.js";
import { handlePlanner } from "../netlify/lib/posts.js";
import { refreshPostStatus, runPublishingTick, validatePostForPublishing, type PublishingPost } from "../netlify/lib/publishing.js";
import { encryptTikTokToken } from "../netlify/lib/tiktok.js";

process.env.DATABASE_URL = "postgresql://test:test@localhost/test";
process.env.TOKEN_ENCRYPTION_KEY = "cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=";
process.env.SESSION_SECRET = "publishing-test-secret".repeat(3);
process.env.URL = "https://creator.example";
process.env.TIKTOK_MEDIA_URL_PREFIX = "https://creator.example/tiktok-media/";
process.env.TIKTOK_PUBLISHING_ENABLED = "1";
process.env.TIKTOK_CLIENT_KEY = "test-client-key";
process.env.TIKTOK_CLIENT_SECRET = "test-client-secret";
process.env.NEON_STORAGE_ACCESS_KEY_ID = "test-access-key";
process.env.NEON_STORAGE_SECRET_ACCESS_KEY = "test-secret-key";
process.env.NEON_STORAGE_ENDPOINT_URL_S3 = "https://storage.example";
process.env.NEON_STORAGE_REGION = "test-region";
delete process.env.TIKTOK_APP_AUDITED;

const creator = {
  privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"], max_video_post_duration_sec: 300,
  comment_disabled: false, duet_disabled: true, stitch_disabled: false,
};

function post(overrides: Record<string, unknown> = {}): PublishingPost {
  return {
    id: "7", user_id: "42", status: "queued", media_asset_id: "3", duration_seconds: 5,
    caption: "Reviewed caption", privacy_level: "SELF_ONLY", allow_comment: true,
    allow_duet: false, allow_stitch: false, brand_organic_toggle: false,
    brand_content_toggle: false, is_aigc: true, approved_at: new Date(),
    approved_tiktok_open_id: "approved-account", scheduled_at: new Date(Date.now() - 1000),
    storage_key: "users/42/12345678901234567890123456789012.mp4", tiktok_publish_id: null,
    ...overrides,
  };
}

type FakeOptions = {
  post?: PublishingPost;
  accountId?: string;
  revokePostingAfterCreatorInfo?: boolean;
  init?: () => Promise<Response>;
  providerStatus?: Record<string, unknown>;
};

async function fakePublishing<T>(options: FakeOptions, run: (state: { post: PublishingPost; inits: Record<string, unknown>[]; committedBeforeInit: boolean }) => Promise<T>): Promise<T> {
  const current = options.post ?? post();
  const state = { post: current, inits: [] as Record<string, unknown>[], committedBeforeInit: false };
  const account = {
    open_id: options.accountId ?? "approved-account", username: "Test creator", granted_scopes: ["user.info.basic", "video.publish"],
    access_token_ciphertext: encryptTikTokToken("test-access-token"), refresh_token_ciphertext: encryptTikTokToken("test-refresh-token"),
    access_expires_at: new Date(Date.now() + 3600_000), refresh_expires_at: new Date(Date.now() + 86400_000),
  };
  const pool = getPool();
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const originalFetch = globalThis.fetch;
  let claimSeen = false;
  const rows = (value: unknown[]) => ({ rows: value, rowCount: value.length });
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql === "COMMIT" && claimSeen) state.committedBeforeInit = true;
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return rows([]);
    if (sql.includes("FROM tiktok_accounts")) return rows([account]);
    if (sql.startsWith("SELECT id FROM users")) return rows([{ id: "42" }]);
    if (sql.includes("FROM user_settings")) return rows([{ queue_times: ["09:00", "18:00"] }]);
    if (sql.startsWith("SELECT scheduled_at")) return rows([]);
    if (sql.startsWith("SELECT p.*, m.storage_key")) {
      assert.match(sql, /approved_at IS NOT NULL/);
      assert.match(sql, /FOR UPDATE OF p SKIP LOCKED/);
      return rows(["queued", "scheduled"].includes(current.status) && current.approved_at && current.approved_tiktok_open_id ? [{ ...current }] : []);
    }
    if (sql.startsWith("SELECT id, user_id")) return rows(current.tiktok_publish_id && current.status === "publishing" ? [{ id: current.id, user_id: current.user_id }] : []);
    if (sql.startsWith("SELECT * FROM posts")) return rows(String(values[1]) === String(current.user_id) ? [{ ...current }] : []);
    if (sql.startsWith("UPDATE posts SET status = 'publishing'")) {
      current.status = "publishing";
      current.tiktok_publish_id = null;
      claimSeen = true;
      return rows([]);
    }
    if (sql.startsWith("UPDATE posts SET tiktok_publish_id =")) {
      current.tiktok_publish_id = String(values[0]);
      return rows([current]);
    }
    if (sql.startsWith("UPDATE posts SET status = $1")) {
      Object.assign(current, { status: values[0], scheduled_at: values[1], approved_at: values[2], approved_tiktok_open_id: values[3] });
      return rows([current]);
    }
    if (sql.startsWith("UPDATE posts SET last_status_checked_at =")) return rows([current]);
    if (sql.startsWith("UPDATE posts SET status = 'published'")) {
      current.status = "published";
      current.tiktok_post_id = values[0];
      return rows([current]);
    }
    if (sql.startsWith("UPDATE posts SET status = 'failed'") && !sql.includes("planned time passed")) {
      current.status = "failed";
      current.last_error = values[0];
      return rows([current]);
    }
    if (sql.startsWith("UPDATE posts SET last_error = $1,")) { current.last_error = values[0]; return rows([current]); }
    if (sql.startsWith("UPDATE posts SET last_error = $1 WHERE id")) { current.last_error = values[0]; return rows([current]); }
    if (sql.startsWith("UPDATE posts SET last_error") || sql.startsWith("UPDATE posts SET status = 'failed'")) return rows([]);
    throw new Error("Unexpected SQL: " + sql);
  };
  pool.query = query as typeof pool.query;
  pool.connect = (async () => ({ query, release() {} })) as unknown as typeof pool.connect;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/creator_info/query/")) {
      if (options.revokePostingAfterCreatorInfo) account.granted_scopes = ["user.info.basic"];
      return Response.json({ data: creator, error: { code: "ok" } });
    }
    if (url.endsWith("/video/init/")) {
      state.inits.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      assert.equal(state.committedBeforeInit, true);
      return options.init ? options.init() : Response.json({ data: { publish_id: "v_pub_url~test" }, error: { code: "ok" } });
    }
    if (url.endsWith("/status/fetch/")) return Response.json({ data: options.providerStatus ?? { status: "PROCESSING_DOWNLOAD" }, error: { code: "ok" } });
    throw new Error("Unexpected fetch host");
  }) as typeof fetch;
  try { return await run(state); }
  finally { pool.query = originalQuery; pool.connect = originalConnect; globalThis.fetch = originalFetch; }
}

test("publishing validates account privacy, maximum duration, and interaction choices", () => {
  assert.doesNotThrow(() => validatePostForPublishing(post(), creator));
  assert.throws(() => validatePostForPublishing(post({ privacy_level: null }), creator), /privacy setting/);
  assert.throws(() => validatePostForPublishing(post({ privacy_level: "PUBLIC_TO_EVERYONE" }), creator), /Only me/);
  assert.throws(() => validatePostForPublishing(post({ duration_seconds: 301 }), creator), /longer/);
  assert.throws(() => validatePostForPublishing(post({ allow_duet: true }), creator), /interaction/);
  assert.throws(() => validatePostForPublishing(post({ brand_content_toggle: true }), creator), /Branded content/);
});

test("an approved private plan remains on hold without separate TikTok consent", async () => {
  await fakePublishing({ post: post({ status: "draft", approved_at: null, approved_tiktok_open_id: null }) }, async (state) => {
    const response = await handlePlanner(new Request("https://creator.example/api/posts/7/queue", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved: true }),
    }), 42);
    assert.equal(response.status, 200);
    assert.equal(state.post.approved_at, null);
    await runPublishingTick({ maxStatusChecks: 0 });
    assert.equal(state.inits.length, 0);
  });
});

test("the worker durably claims a post before one PULL_FROM_URL request", async () => {
  await fakePublishing({}, async (state) => {
    const first = await runPublishingTick({ maxStatusChecks: 0 });
    const second = await runPublishingTick({ maxStatusChecks: 0 });
    assert.equal(first.submitted, 1);
    assert.equal(second.submitted, 0);
    assert.equal(state.inits.length, 1);
    assert.equal(state.post.tiktok_publish_id, "v_pub_url~test");
    const body = state.inits[0] as { source_info: { source: string; video_url: string }; post_info: Record<string, unknown> };
    assert.equal(body.source_info.source, "PULL_FROM_URL");
    assert.ok(body.source_info.video_url.startsWith("https://creator.example/tiktok-media/video.mp4?token="));
    assert.equal(body.post_info.title, "Reviewed caption");
    assert.equal(body.post_info.disable_duet, true);
    assert.equal(body.post_info.is_aigc, true);
  });
});

test("a lost TikTok init response stays held and cannot be retried or moved to drafts", async () => {
  await fakePublishing({ init: async () => { throw new Error("lost response"); } }, async (state) => {
    const first = await runPublishingTick({ maxStatusChecks: 0 });
    await runPublishingTick({ maxStatusChecks: 0 });
    assert.equal(first.held, 1);
    assert.equal(state.inits.length, 1);
    assert.equal(state.post.status, "publishing");
    assert.equal(state.post.tiktok_publish_id, null);
    assert.match(String(state.post.last_error), /uncertain/);
    await assert.rejects(() => handlePlanner(new Request("https://creator.example/api/posts/7/draft", { method: "POST" }), 42), (error: unknown) => error instanceof ApiError && error.status === 409);
  });
});

test("a changed TikTok account cannot receive an old scheduled approval", async () => {
  await fakePublishing({ accountId: "different-account" }, async (state) => {
    const result = await runPublishingTick({ maxStatusChecks: 0 });
    assert.equal(result.failed, 1);
    assert.equal(state.inits.length, 0);
    assert.equal(state.post.status, "failed");
    assert.match(String(state.post.last_error), /account changed/);
  });
});

test("posting permission revoked before init fails locally without an uncertain hold", async () => {
  await fakePublishing({ revokePostingAfterCreatorInfo: true }, async (state) => {
    const result = await runPublishingTick({ maxStatusChecks: 0 });
    assert.equal(result.failed, 1);
    assert.equal(result.held, 0);
    assert.equal(state.inits.length, 0);
    assert.equal(state.post.status, "failed");
    assert.match(String(state.post.last_error), /Reconnect TikTok/);
  });
});

test("private completion is published with unavailable public analytics ID", async () => {
  await fakePublishing({ post: post({ status: "publishing", tiktok_publish_id: "v_pub_url~test" }), providerStatus: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] } }, async (state) => {
    const result = await refreshPostStatus(42, "7");
    assert.equal(result.status, "published");
    assert.equal(result.tiktok_post_id, null);
    assert.equal(state.inits.length, 0);
  });
});

test("public completion keeps the exact TikTok video ID and rejects foreign ownership", async () => {
  await fakePublishing({ post: post({ status: "publishing", tiktok_publish_id: "v_pub_url~test" }), providerStatus: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["7491700870045678912"] } }, async () => {
    const result = await refreshPostStatus(42, "7");
    assert.equal(result.tiktok_post_id, "7491700870045678912");
    await assert.rejects(() => refreshPostStatus(43, "7"), (error: unknown) => error instanceof ApiError && error.status === 404);
  });
});
