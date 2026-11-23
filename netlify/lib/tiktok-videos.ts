import { getPool } from "./db.js";
import { ApiError, json, readJson } from "./http.js";
import { getTikTokAccount, tikTokApi } from "./tiktok.js";
import { videoCounts } from "./analytics.js";

const PAGE_SIZE = 20;
const LATEST_COOLDOWN_SECONDS = 60;
const METRIC_REFRESH_SECONDS = 6 * 60 * 60;
const VIDEO_FIELDS = [
  "id", "create_time", "cover_image_url", "share_url", "video_description", "duration", "title", "embed_link",
  "view_count", "like_count", "comment_count", "share_count",
].join(",");
const METRIC_UNAVAILABLE = "TikTok did not return public metrics for this video. It may be private, unavailable, or still processing.";

type TikTokVideo = Record<string, unknown>;
type AccountVideoRow = {
  video_id: string;
  create_time: Date;
  title: string;
  video_description: string;
  duration_seconds: number | null;
  cover_image_url: string | null;
  share_url: string | null;
  embed_link: string | null;
  view_count: string | null;
  like_count: string | null;
  comment_count: string | null;
  share_count: string | null;
  metrics_synced_at: Date | null;
  metrics_error: string | null;
};

function safeUrl(value: unknown, allowedHostSuffixes?: string[]): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (allowedHostSuffixes && !allowedHostSuffixes.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))) return null;
    return url.href;
  } catch {
    return null;
  }
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function videoId(value: unknown): string | null {
  return typeof value === "string" && /^\d{1,40}$/.test(value) ? value : null;
}

function availableReason(account: Awaited<ReturnType<typeof getTikTokAccount>>): string | null {
  if (!account.connected) return "Connect TikTok to load the public videos on your account.";
  if (account.authorization_expired) return "Your TikTok connection expired. Reconnect it to load account posts.";
  if (!account.scopes.includes("video.list")) return "Reconnect TikTok and authorize video.list to load your public account posts.";
  return null;
}

async function stateFor(userId: number, openId: string): Promise<{
  next_cursor: string | null; has_more: boolean; initialized_at: Date | null; latest_checked_at: Date | null;
}> {
  const result = await getPool().query<{
    next_cursor: string | null; has_more: boolean; initialized_at: Date | null; latest_checked_at: Date | null;
  }>(
    `SELECT next_cursor::text, has_more, initialized_at, latest_checked_at
       FROM tiktok_video_sync_state WHERE user_id = $1 AND open_id = $2`, [userId, openId],
  );
  return result.rows[0] ?? { next_cursor: null, has_more: true, initialized_at: null, latest_checked_at: null };
}

async function listAccountVideos(userId: number, request: Request): Promise<Response> {
  const account = await getTikTokAccount(userId);
  const reason = availableReason(account);
  if (reason || !account.open_id) {
    return json(200, { available: false, reason, videos: [], summary: null, page: { offset: 0, limit: PAGE_SIZE, has_cached_more: false }, sync: null });
  }
  const url = new URL(request.url);
  const rawOffset = Number(url.searchParams.get("offset") ?? 0);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? Math.min(rawOffset, 1_000_000) : 0;
  const pool = getPool();
  const [state, rows, total] = await Promise.all([
    stateFor(userId, account.open_id),
    pool.query<AccountVideoRow>(
      `SELECT video_id, create_time, title, video_description, duration_seconds, cover_image_url, share_url, embed_link,
              view_count, like_count, comment_count, share_count, metrics_synced_at, metrics_error
         FROM tiktok_account_videos WHERE user_id = $1 AND open_id = $2
         ORDER BY create_time DESC, video_id DESC LIMIT $3 OFFSET $4`,
      [userId, account.open_id, PAGE_SIZE + 1, offset],
    ),
    pool.query<{
      video_count: string; videos_with_metrics: string; view_count: string | null; like_count: string | null;
      comment_count: string | null; share_count: string | null; last_synced_at: Date | null;
    }>(
      `SELECT count(*) AS video_count,
              count(*) FILTER (WHERE view_count IS NOT NULL AND like_count IS NOT NULL AND comment_count IS NOT NULL AND share_count IS NOT NULL) AS videos_with_metrics,
              sum(view_count) AS view_count, sum(like_count) AS like_count,
              sum(comment_count) AS comment_count, sum(share_count) AS share_count,
              max(metrics_synced_at) AS last_synced_at
         FROM tiktok_account_videos WHERE user_id = $1 AND open_id = $2`, [userId, account.open_id],
    ),
  ]);
  const summary = total.rows[0];
  const hasCachedMore = rows.rows.length > PAGE_SIZE;
  return json(200, {
    available: true,
    account: { username: account.username },
    initialized: Boolean(state.initialized_at),
    videos: rows.rows.slice(0, PAGE_SIZE),
    summary: {
      video_count: Number(summary.video_count),
      videos_with_metrics: Number(summary.videos_with_metrics),
      totals: { view_count: summary.view_count, like_count: summary.like_count, comment_count: summary.comment_count, share_count: summary.share_count },
      last_synced_at: summary.last_synced_at,
    },
    page: { offset, limit: PAGE_SIZE, has_cached_more: hasCachedMore },
    sync: { has_more: state.has_more, latest_checked_at: state.latest_checked_at },
  });
}

async function saveListedVideos(userId: number, openId: string, videos: unknown[]): Promise<number> {
  let saved = 0;
  for (const value of videos) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const video = value as TikTokVideo;
    const id = videoId(video.id);
    const created = typeof video.create_time === "number" && Number.isSafeInteger(video.create_time)
      ? new Date(video.create_time * 1000) : null;
    if (!id || !created || Number.isNaN(created.valueOf())) continue;
    const title = typeof video.title === "string" ? video.title.slice(0, 150) : "";
    const description = typeof video.video_description === "string" ? video.video_description.slice(0, 500) : "";
    const duration = positiveInteger(video.duration);
    const cover = safeUrl(video.cover_image_url, ["tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokcdn-in.com"]);
    const shareUrl = safeUrl(video.share_url, ["tiktok.com"]);
    const embedLink = safeUrl(video.embed_link, ["tiktok.com"]);
    const counts = videoCounts(video);
    const result = await getPool().query(
      `INSERT INTO tiktok_account_videos
         (user_id, open_id, video_id, create_time, title, video_description, duration_seconds, cover_image_url, share_url, embed_link,
          view_count, like_count, comment_count, share_count, metrics_synced_at, metrics_checked_at, last_seen_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
              CASE WHEN $11::bigint IS NOT NULL THEN now() END,
              CASE WHEN $11::bigint IS NOT NULL THEN now() END,
              now()
         WHERE EXISTS (SELECT 1 FROM tiktok_accounts WHERE user_id = $1 AND open_id = $2)
       ON CONFLICT (user_id, open_id, video_id) DO UPDATE SET
         create_time = EXCLUDED.create_time,
         title = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE tiktok_account_videos.title END,
         video_description = CASE WHEN EXCLUDED.video_description <> '' THEN EXCLUDED.video_description ELSE tiktok_account_videos.video_description END,
         duration_seconds = COALESCE(EXCLUDED.duration_seconds, tiktok_account_videos.duration_seconds),
         cover_image_url = COALESCE(EXCLUDED.cover_image_url, tiktok_account_videos.cover_image_url),
         share_url = COALESCE(EXCLUDED.share_url, tiktok_account_videos.share_url),
         embed_link = COALESCE(EXCLUDED.embed_link, tiktok_account_videos.embed_link),
         view_count = COALESCE(EXCLUDED.view_count, tiktok_account_videos.view_count),
         like_count = COALESCE(EXCLUDED.like_count, tiktok_account_videos.like_count),
         comment_count = COALESCE(EXCLUDED.comment_count, tiktok_account_videos.comment_count),
         share_count = COALESCE(EXCLUDED.share_count, tiktok_account_videos.share_count),
         metrics_synced_at = COALESCE(EXCLUDED.metrics_synced_at, tiktok_account_videos.metrics_synced_at),
         metrics_checked_at = COALESCE(EXCLUDED.metrics_checked_at, tiktok_account_videos.metrics_checked_at),
         metrics_error = CASE WHEN EXCLUDED.metrics_synced_at IS NOT NULL THEN NULL ELSE tiktok_account_videos.metrics_error END,
         last_seen_at = now()
       WHERE EXISTS (SELECT 1 FROM tiktok_accounts WHERE user_id = $1 AND open_id = $2)`,
      [userId, openId, id, created, title, description, duration, cover, shareUrl, embedLink,
        counts?.view_count ?? null, counts?.like_count ?? null, counts?.comment_count ?? null, counts?.share_count ?? null],
    );
    saved += result.rowCount ?? 0;
  }
  return saved;
}

async function syncVideoPage(userId: number, older: boolean): Promise<Record<string, unknown>> {
  const account = await getTikTokAccount(userId);
  const reason = availableReason(account);
  if (reason || !account.open_id) throw new ApiError(account.connected ? 403 : 409, reason ?? "Connect TikTok first.");
  const pool = getPool();
  await pool.query(
    `INSERT INTO tiktok_video_sync_state (user_id, open_id) VALUES ($1, $2) ON CONFLICT (user_id, open_id) DO NOTHING`,
    [userId, account.open_id],
  );
  const claim = await pool.query<{
    next_cursor: string | null; has_more: boolean; latest_checked_at: Date | null; initialized_at: Date | null;
  }>(
    `UPDATE tiktok_video_sync_state SET
       latest_checked_at = CASE WHEN $3::boolean THEN now() ELSE latest_checked_at END,
       sync_lease_until = now() + interval '45 seconds', updated_at = now()
     WHERE user_id = $1 AND open_id = $2
       AND (sync_lease_until IS NULL OR sync_lease_until < now())
       AND ($3::boolean = false OR latest_checked_at IS NULL OR latest_checked_at < now() - ($4 * interval '1 second'))
       AND ($3::boolean = true OR (has_more AND next_cursor IS NOT NULL))
     RETURNING next_cursor::text, has_more, latest_checked_at, initialized_at`,
    [userId, account.open_id, !older, LATEST_COOLDOWN_SECONDS],
  );
  if (!claim.rows[0]) {
    const current = await stateFor(userId, account.open_id);
    const videos = await getPool().query<AccountVideoRow>(
      `SELECT video_id, create_time, title, video_description, duration_seconds, cover_image_url, share_url, embed_link,
              view_count, like_count, comment_count, share_count, metrics_synced_at, metrics_error
         FROM tiktok_account_videos WHERE user_id = $1 AND open_id = $2
         ORDER BY create_time DESC, video_id DESC LIMIT $3`, [userId, account.open_id, PAGE_SIZE],
    );
    const retryAfter = !older && current.latest_checked_at
      ? Math.max(1, Math.ceil((new Date(current.latest_checked_at).getTime() + LATEST_COOLDOWN_SECONDS * 1000 - Date.now()) / 1000))
      : 0;
    return {
      videos: videos.rows,
      sync: {
        checked: 0, saved: 0, cooldown: Boolean(retryAfter), retry_after: retryAfter,
        busy: !retryAfter && (!older || current.has_more), no_more: older && !current.has_more,
        initialized: Boolean(current.initialized_at), has_more: current.has_more,
      },
    };
  }

  const current = claim.rows[0];
  if (older && (!current.has_more || !current.next_cursor)) {
    await pool.query("UPDATE tiktok_video_sync_state SET sync_lease_until = NULL WHERE user_id = $1 AND open_id = $2", [userId, account.open_id]);
    return { videos: [], sync: { checked: 0, saved: 0, cooldown: false, no_more: true, has_more: false } };
  }
  const payload: Record<string, unknown> = { max_count: PAGE_SIZE };
  if (older && current.next_cursor) payload.cursor = current.next_cursor;
  try {
    const result = await tikTokApi(
      userId,
      `/v2/video/list/?fields=${VIDEO_FIELDS}`,
      payload,
      "POST",
      account.open_id,
    );
    if (!Array.isArray(result.videos) || typeof result.has_more !== "boolean") {
      throw new ApiError(502, "TikTok returned an incomplete video list. Try syncing again.");
    }
    const nextCursor = typeof result.cursor === "number" && Number.isSafeInteger(result.cursor) && result.cursor >= 0
      ? String(result.cursor)
      : typeof result.cursor === "string" && /^\d{1,19}$/.test(result.cursor) ? result.cursor : null;
    const hasMore = result.has_more === true && Boolean(nextCursor) && nextCursor !== current.next_cursor;
    const saved = await saveListedVideos(userId, account.open_id, result.videos);
    await pool.query(
      `UPDATE tiktok_video_sync_state SET next_cursor = $3::bigint, has_more = $4,
         initialized_at = COALESCE(initialized_at, now()), sync_lease_until = NULL,
         updated_at = now()
       WHERE user_id = $1 AND open_id = $2`,
      [userId, account.open_id, hasMore ? nextCursor : null, hasMore],
    );
    return {
      videos: result.videos,
      sync: {
        checked: result.videos.length, saved, cooldown: false, retry_after: 0,
        has_more: hasMore, no_more: !hasMore,
      },
    };
  } catch (error) {
    await pool.query(
      `UPDATE tiktok_video_sync_state SET sync_lease_until = NULL, updated_at = now() WHERE user_id = $1 AND open_id = $2`,
      [userId, account.open_id],
    );
    throw error;
  }
}

async function refreshAccountMetrics(userId: number): Promise<Record<string, unknown>> {
  const account = await getTikTokAccount(userId);
  const reason = availableReason(account);
  if (reason || !account.open_id) throw new ApiError(account.connected ? 403 : 409, reason ?? "Connect TikTok first.");
  const rows = await getPool().query<{ video_id: string }>(
    `WITH due AS (
       SELECT video_id FROM tiktok_account_videos
        WHERE user_id = $1 AND open_id = $2
          AND (metrics_checked_at IS NULL OR metrics_checked_at < now() - ($3 * interval '1 second'))
        ORDER BY metrics_checked_at NULLS FIRST, create_time DESC, video_id DESC
        LIMIT $4 FOR UPDATE SKIP LOCKED
     ) UPDATE tiktok_account_videos AS v SET metrics_checked_at = now()
       FROM due WHERE v.user_id = $1 AND v.open_id = $2 AND v.video_id = due.video_id
       RETURNING v.video_id`,
    [userId, account.open_id, METRIC_REFRESH_SECONDS, PAGE_SIZE],
  );
  if (!rows.rows.length) {
    const status = await getPool().query<{ count: string; retry_after: number | null }>(
      `SELECT count(*) AS count,
         ceil(greatest(0, extract(epoch FROM (min(metrics_checked_at) + ($3 * interval '1 second') - now())))::numeric)::int AS retry_after
       FROM tiktok_account_videos WHERE user_id = $1 AND open_id = $2`,
      [userId, account.open_id, METRIC_REFRESH_SECONDS],
    );
    const count = Number(status.rows[0]?.count ?? 0);
    return { checked: 0, updated: 0, unavailable: 0, cooldown: count > 0, retry_after: status.rows[0]?.retry_after ?? 0, no_posts: count === 0 };
  }
  let response: Record<string, unknown>;
  try {
    response = await tikTokApi(
      userId,
      `/v2/video/query/?fields=${VIDEO_FIELDS}`,
      { filters: { video_ids: rows.rows.map((row) => row.video_id) } },
      "POST",
      account.open_id,
    );
  } catch (error) {
    const detail = error instanceof ApiError ? error.message : "TikTok could not refresh these metrics. Try again later.";
    await getPool().query(
      `UPDATE tiktok_account_videos SET metrics_error = $3
        WHERE user_id = $1 AND open_id = $2 AND video_id = ANY($4::text[])`,
      [userId, account.open_id, detail.slice(0, 500), rows.rows.map((row) => row.video_id)],
    );
    throw error;
  }
  if (!Array.isArray(response.videos)) throw new ApiError(502, "TikTok returned no video metrics.");
  const videos = new Map<string, TikTokVideo>();
  for (const value of response.videos) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as TikTokVideo;
      const id = videoId(record.id);
      if (id) videos.set(id, record);
    }
  }
  let updated = 0;
  let unavailable = 0;
  for (const row of rows.rows) {
    const video = videos.get(row.video_id);
    const counts = videoCounts(video);
    if (!video || !counts) {
      await getPool().query(
        `UPDATE tiktok_account_videos SET metrics_error = $4
          WHERE user_id = $1 AND open_id = $2 AND video_id = $3
            AND EXISTS (SELECT 1 FROM tiktok_accounts WHERE user_id = $1 AND open_id = $2)`,
        [userId, account.open_id, row.video_id, METRIC_UNAVAILABLE],
      );
      unavailable += 1;
      continue;
    }
    const cover = safeUrl(video.cover_image_url, ["tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokcdn-in.com"]);
    const shareUrl = safeUrl(video.share_url, ["tiktok.com"]);
    const embedLink = safeUrl(video.embed_link, ["tiktok.com"]);
    const result = await getPool().query(
      `UPDATE tiktok_account_videos SET
         view_count = $4, like_count = $5, comment_count = $6, share_count = $7,
         metrics_synced_at = now(), metrics_error = NULL,
         title = CASE WHEN $8 <> '' THEN $8 ELSE title END,
         video_description = CASE WHEN $9 <> '' THEN $9 ELSE video_description END,
         cover_image_url = COALESCE($10, cover_image_url), share_url = COALESCE($11, share_url),
         embed_link = COALESCE($12, embed_link)
       WHERE user_id = $1 AND open_id = $2 AND video_id = $3
         AND EXISTS (SELECT 1 FROM tiktok_accounts WHERE user_id = $1 AND open_id = $2)`,
      [userId, account.open_id, row.video_id, counts.view_count, counts.like_count, counts.comment_count, counts.share_count,
        typeof video.title === "string" ? video.title.slice(0, 150) : "",
        typeof video.video_description === "string" ? video.video_description.slice(0, 500) : "",
        cover, shareUrl, embedLink],
    );
    updated += result.rowCount ?? 0;
  }
  return { checked: rows.rows.length, updated, unavailable, cooldown: false, retry_after: 0, no_posts: false };
}

export async function handleTikTokVideos(request: Request, userId: number, pathname: string): Promise<Response | null> {
  if (pathname === "/api/tiktok/videos") {
    if (request.method !== "GET") throw new ApiError(405, "Method not allowed.");
    return listAccountVideos(userId, request);
  }
  if (pathname === "/api/tiktok/videos/sync") {
    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const body = await readJson(request);
    if (body.older !== undefined && typeof body.older !== "boolean") throw new ApiError(400, "Choose whether to sync older posts.");
    return json(200, await syncVideoPage(userId, body.older === true));
  }
  if (pathname === "/api/tiktok/videos/metrics") {
    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    return json(200, { refresh: await refreshAccountMetrics(userId) });
  }
  return null;
}
