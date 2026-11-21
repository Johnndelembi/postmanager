import { getPool } from "./db.js";
import { ApiError, json } from "./http.js";
import { getTikTokAccount, tikTokApi } from "./tiktok.js";

const COUNTS = ["view_count", "like_count", "comment_count", "share_count"] as const;
const MAX_COUNT = 9223372036854775807n;
const SYNC_INTERVAL_SECONDS = 6 * 60 * 60;
const MANUAL_COOLDOWN_SECONDS = 60;
const MAX_BATCH = 20;
const UNAVAILABLE = "TikTok did not return public metrics for this video. It may be private, unavailable, or still processing.";

type Counts = Record<(typeof COUNTS)[number], string>;
type SyncPost = { id: string; user_id: string; tiktok_post_id: string; approved_tiktok_open_id: string };
type MetricRow = {
  id: string; title: string; caption: string; privacy_level: string | null; tiktok_post_id: string | null;
  published_at: Date | null; view_count: string | null; like_count: string | null;
  comment_count: string | null; share_count: string | null; analytics_synced_at: Date | null;
  analytics_checked_at: Date | null; analytics_error: string | null;
  approved_tiktok_open_id: string | null;
};

export type AnalyticsSyncResult = {
  checked: number; updated: number; unavailable: number; cooldown: boolean; retry_after: number;
};

export function videoCounts(value: unknown): Counts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const video = value as Record<string, unknown>;
  const counts = {} as Counts;
  for (const field of COUNTS) {
    const count = video[field];
    const decimal = typeof count === "number" && Number.isSafeInteger(count) ? String(count) : count;
    if (typeof decimal !== "string" || !/^\d{1,19}$/.test(decimal) || BigInt(decimal) > MAX_COUNT) return null;
    counts[field] = decimal;
  }
  return counts;
}

async function recordUnavailable(posts: SyncPost[], message: string): Promise<void> {
  if (!posts.length) return;
  await getPool().query(
    "UPDATE posts SET analytics_error = $1 WHERE id = ANY($2::bigint[]) AND user_id = $3 AND approved_tiktok_open_id = $4",
    [message.slice(0, 500), posts.map((post) => post.id), posts[0].user_id, posts[0].approved_tiktok_open_id],
  );
}

async function saveCounts(post: SyncPost, counts: Counts): Promise<boolean> {
  // The snapshot and latest counts commit together, and a changed account cannot attach metrics to this post.
  const result = await getPool().query(
    `WITH updated AS (
       UPDATE posts AS p SET view_count = $1, like_count = $2, comment_count = $3, share_count = $4,
         analytics_synced_at = now(), analytics_error = NULL
       WHERE p.id = $5 AND p.user_id = $6 AND p.tiktok_post_id = $7
         AND p.approved_tiktok_open_id = $8
         AND EXISTS (SELECT 1 FROM tiktok_accounts a WHERE a.user_id = p.user_id AND a.open_id = $8)
       RETURNING p.id
     ) INSERT INTO post_metric_snapshots (post_id, view_count, like_count, comment_count, share_count)
       SELECT id, $1, $2, $3, $4 FROM updated`,
    [counts.view_count, counts.like_count, counts.comment_count, counts.share_count,
      post.id, post.user_id, post.tiktok_post_id, post.approved_tiktok_open_id],
  );
  return Boolean(result.rowCount);
}

export async function syncAnalytics(userId?: number, limit = MAX_BATCH, manual = false): Promise<AnalyticsSyncResult> {
  const result: AnalyticsSyncResult = { checked: 0, updated: 0, unavailable: 0, cooldown: false, retry_after: 0 };
  const batchSize = Math.max(1, Math.min(MAX_BATCH, Math.floor(limit)));
  const cooldown = manual ? MANUAL_COOLDOWN_SECONDS : SYNC_INTERVAL_SECONDS;
  let owner = userId;
  if (owner === undefined) {
    const candidate = await getPool().query<{ user_id: string }>(
      `SELECT p.user_id FROM posts p JOIN tiktok_accounts a ON a.user_id = p.user_id
       WHERE p.status = 'published' AND p.tiktok_post_id IS NOT NULL
         AND p.approved_tiktok_open_id = a.open_id AND 'video.list' = ANY(a.granted_scopes)
         AND a.refresh_expires_at > now()
         AND (p.analytics_checked_at IS NULL OR p.analytics_checked_at < now() - ($1 * interval '1 second'))
       ORDER BY p.analytics_checked_at NULLS FIRST, p.id LIMIT 1`,
      [cooldown],
    );
    if (!candidate.rows[0]) return result;
    owner = Number(candidate.rows[0].user_id);
  }
  if (!Number.isSafeInteger(owner) || owner < 1) throw new ApiError(400, "Choose a valid account.");
  const account = await getTikTokAccount(owner);
  if (!account.connected || !account.open_id) throw new ApiError(409, "Connect TikTok to refresh analytics.");
  if (account.authorization_expired || !account.scopes.includes("video.list")) {
    throw new ApiError(403, "Reconnect TikTok and authorize video.list to refresh public video metrics.");
  }
  const claimed = await getPool().query<SyncPost>(
    `WITH due AS (
       SELECT p.id FROM posts p
       WHERE p.user_id = $1 AND p.status = 'published' AND p.tiktok_post_id IS NOT NULL
         AND p.approved_tiktok_open_id = $2
         AND (p.analytics_checked_at IS NULL OR p.analytics_checked_at < now() - ($3 * interval '1 second'))
       ORDER BY p.analytics_checked_at NULLS FIRST, p.id LIMIT $4 FOR UPDATE SKIP LOCKED
     ) UPDATE posts p SET analytics_checked_at = now()
       FROM due WHERE p.id = due.id
       RETURNING p.id, p.user_id, p.tiktok_post_id, p.approved_tiktok_open_id`,
    [owner, account.open_id, cooldown, batchSize],
  );
  const posts = claimed.rows;
  if (!posts.length) {
    result.cooldown = true;
    result.retry_after = cooldown;
    return result;
  }
  result.checked = posts.length;
  let response: Record<string, unknown>;
  try {
    response = await tikTokApi(owner, "/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count", {
      filters: { video_ids: [...new Set(posts.map((post) => post.tiktok_post_id))] },
    }, "POST", account.open_id);
    if (!Array.isArray(response.videos)) throw new ApiError(502, "TikTok returned no video metrics.");
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Video metrics could not be refreshed. Try again later.";
    await recordUnavailable(posts, message);
    if (manual) throw error;
    return { ...result, unavailable: posts.length };
  }
  const videos = new Map<string, unknown>();
  for (const value of response.videos as unknown[]) {
    if (!value || typeof value !== "object" || !("id" in value)) continue;
    const id = value.id;
    if (typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id))) videos.set(String(id), value);
  }
  for (const post of posts) {
    const counts = videoCounts(videos.get(post.tiktok_post_id));
    if (counts) {
      if (await saveCounts(post, counts)) result.updated += 1;
      else result.unavailable += 1;
    } else {
      await recordUnavailable([post], UNAVAILABLE);
      result.unavailable += 1;
    }
  }
  return result;
}

async function overview(userId: number): Promise<Record<string, unknown>> {
  const [account, summary, rows] = await Promise.all([
    getTikTokAccount(userId),
    getPool().query<{
      published_posts: string; posts_with_metrics: string; view_count: string | null; like_count: string | null;
      comment_count: string | null; share_count: string | null; last_synced_at: Date | null;
    }>(
      `SELECT count(*) AS published_posts,
         count(*) FILTER (WHERE view_count IS NOT NULL AND like_count IS NOT NULL AND comment_count IS NOT NULL AND share_count IS NOT NULL) AS posts_with_metrics,
         sum(view_count) AS view_count, sum(like_count) AS like_count,
         sum(comment_count) AS comment_count, sum(share_count) AS share_count,
         max(analytics_synced_at) AS last_synced_at
       FROM posts WHERE user_id = $1 AND status = 'published'`, [userId],
    ),
    getPool().query<MetricRow>(
      `SELECT id, title, caption, privacy_level, tiktok_post_id, published_at,
         view_count, like_count, comment_count, share_count,
         analytics_synced_at, analytics_checked_at, analytics_error, approved_tiktok_open_id
       FROM posts WHERE user_id = $1 AND status = 'published' ORDER BY published_at DESC NULLS LAST, id DESC LIMIT 100`, [userId],
    ),
  ]);
  const snapshots = rows.rows.length ? await getPool().query<{
    post_id: string; captured_at: Date; view_count: string; like_count: string; comment_count: string; share_count: string;
  }>(
    `SELECT s.post_id, s.captured_at, s.view_count, s.like_count, s.comment_count, s.share_count
     FROM posts p CROSS JOIN LATERAL (
       SELECT post_id, captured_at, view_count, like_count, comment_count, share_count FROM post_metric_snapshots
       WHERE post_id = p.id ORDER BY captured_at DESC, id DESC LIMIT 30
     ) s WHERE p.user_id = $1 AND p.id = ANY($2::bigint[]) ORDER BY s.captured_at DESC`,
    [userId, rows.rows.map((post) => post.id)],
  ) : { rows: [] };
  const history = new Map<string, object[]>();
  for (const { post_id, ...snapshot } of snapshots.rows) {
    const list = history.get(post_id) ?? [];
    list.push(snapshot);
    history.set(post_id, list);
  }
  const aggregate = summary.rows[0];
  const available = account.connected && !account.authorization_expired && account.scopes.includes("video.list");
  return {
    available,
    reason: !account.connected ? "Connect TikTok to see public video performance." : !available
      ? "Reconnect TikTok and authorize video.list to sync public video metrics." : null,
    summary: {
      published_posts: Number(aggregate.published_posts), posts_with_metrics: Number(aggregate.posts_with_metrics),
      totals: Object.fromEntries(COUNTS.map((field) => [field, aggregate[field]])),
      last_synced_at: aggregate.last_synced_at,
    },
    posts: rows.rows.map(({ approved_tiktok_open_id, ...post }) => {
      const changedAccount = Boolean(approved_tiktok_open_id && approved_tiktok_open_id !== account.open_id);
      return {
        ...post,
        analytics_error: changedAccount ? "Connect the TikTok account this post was published to before refreshing its metrics." : post.analytics_error,
        stale: changedAccount || Boolean(post.analytics_error) || !post.analytics_synced_at ||
          new Date(post.analytics_synced_at).getTime() < Date.now() - SYNC_INTERVAL_SECONDS * 1000,
        snapshots: history.get(post.id) ?? [],
      };
    }),
    truncated: Number(aggregate.published_posts) > rows.rows.length,
  };
}

export async function handleAnalytics(request: Request, userId: number, pathname: string): Promise<Response | null> {
  if (pathname === "/api/analytics") {
    if (request.method !== "GET") throw new ApiError(405, "Method not allowed.");
    return json(200, await overview(userId));
  }
  if (pathname === "/api/analytics/refresh") {
    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const refresh = await syncAnalytics(userId, MAX_BATCH, true);
    return json(200, { ...await overview(userId), refresh });
  }
  return null;
}
