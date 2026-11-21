import type { PoolClient } from "pg";

import { getPool } from "./db.js";
import { createDeliveryUrl, deliveryConfigured } from "./delivery.js";
import { ApiError } from "./http.js";
import { creatorInfo, getTikTokAccount, TikTokApiError, tikTokApi } from "./tiktok.js";

export type PublishingPost = {
  [column: string]: unknown;
  id: string;
  user_id: string | number;
  status: string;
  media_asset_id: string | null;
  duration_seconds: number | null;
  privacy_level: string | null;
  caption: string;
  storage_key?: string | null;
  approved_tiktok_open_id?: string | null;
  tiktok_publish_id?: string | null;
};

const UNCERTAIN = "Publishing outcome is uncertain. Check your TikTok account and contact support before trying this content again; Postmanager will not resend it automatically.";

export function validatePostForPublishing(post: PublishingPost, creator: Record<string, unknown>): void {
  if (!post.media_asset_id || !Number.isInteger(post.duration_seconds) || Number(post.duration_seconds) <= 0) {
    throw new ApiError(400, "Upload a video and confirm its duration before publishing.");
  }
  const options = creator.privacy_level_options;
  if (!Array.isArray(options) || !post.privacy_level || !options.includes(post.privacy_level)) {
    throw new ApiError(400, "Choose a privacy setting available for this TikTok account.");
  }
  if (process.env.TIKTOK_APP_AUDITED !== "1" && post.privacy_level !== "SELF_ONLY") {
    throw new ApiError(400, "Until the TikTok app passes audit, choose Only me privacy and use a private TikTok account.");
  }
  const maximum = creator.max_video_post_duration_sec;
  if (typeof maximum !== "number" || !Number.isFinite(maximum) || maximum <= 0) {
    throw new ApiError(503, "TikTok did not return an available video duration. Refresh the posting settings.");
  }
  if (Number(post.duration_seconds) > maximum) throw new ApiError(400, "This video is longer than the TikTok account allows.");
  if (post.caption.length > 2200) throw new ApiError(400, "Caption is too long for TikTok.");
  if (post.brand_content_toggle && post.privacy_level === "SELF_ONLY") {
    throw new ApiError(400, "Branded content cannot use Only me privacy.");
  }
  for (const [field, disabled] of [["allow_comment", "comment_disabled"], ["allow_duet", "duet_disabled"], ["allow_stitch", "stitch_disabled"]]) {
    if (typeof creator[disabled] !== "boolean") throw new ApiError(503, "TikTok did not return complete interaction settings. Refresh and try again.");
    if (post[field] && creator[disabled]) throw new ApiError(400, "A selected TikTok interaction is unavailable for this account.");
  }
}

export async function publishingApproval(userId: number): Promise<{ openId: string; creator: Record<string, unknown> }> {
  if (!deliveryConfigured()) throw new ApiError(503, "TikTok publishing is paused until video delivery is configured and enabled.");
  const account = await getTikTokAccount(userId);
  if (!account.connected || !account.open_id) throw new ApiError(409, "Connect a TikTok account first.");
  if (!account.scopes.includes("video.publish")) throw new ApiError(403, "Reconnect TikTok and authorize posting before publishing.");
  return { openId: account.open_id, creator: await creatorInfo(userId, account.open_id) };
}

export async function checkApprovalAccount(db: PoolClient, userId: number, openId: string): Promise<void> {
  const result = await db.query<{ open_id: string; granted_scopes: string[] }>(
    "SELECT open_id, granted_scopes FROM tiktok_accounts WHERE user_id = $1 FOR SHARE", [userId],
  );
  if (result.rows[0]?.open_id !== openId || !result.rows[0].granted_scopes.includes("video.publish")) {
    throw new ApiError(409, "The TikTok account changed. Refresh and review this post again.");
  }
}

function message(error: unknown): string {
  return error instanceof ApiError ? error.message.slice(0, 500) : "The publishing service could not complete this operation. Try checking its status later.";
}

async function failClaim(postId: string, error: unknown): Promise<void> {
  await getPool().query(
    "UPDATE posts SET status = 'failed', last_error = $1, approved_at = NULL, updated_at = now() WHERE id = $2 AND status = 'publishing' AND tiktok_publish_id IS NULL",
    [message(error), postId],
  );
}

async function submitClaim(post: PublishingPost): Promise<"submitted" | "failed" | "held"> {
  let initializing = false;
  try {
    const userId = Number(post.user_id);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !post.approved_tiktok_open_id) throw new ApiError(409, "Review this post for the connected TikTok account before publishing.");
    const approval = await publishingApproval(userId);
    if (approval.openId !== post.approved_tiktok_open_id) throw new ApiError(409, "The connected TikTok account changed. Move this post to drafts and review it again.");
    validatePostForPublishing(post, approval.creator);
    if (!post.storage_key || !post.storage_key.startsWith(`users/${userId}/`)) throw new ApiError(400, "The uploaded video is no longer available for this account.");
    const videoUrl = await createDeliveryUrl(post.storage_key);
    initializing = true;
    const result = await tikTokApi(userId, "/v2/post/publish/video/init/", {
      post_info: {
        title: post.caption,
        privacy_level: post.privacy_level,
        disable_comment: !post.allow_comment,
        disable_duet: !post.allow_duet,
        disable_stitch: !post.allow_stitch,
        brand_organic_toggle: Boolean(post.brand_organic_toggle),
        brand_content_toggle: Boolean(post.brand_content_toggle),
        is_aigc: Boolean(post.is_aigc),
      },
      source_info: { source: "PULL_FROM_URL", video_url: videoUrl },
    }, "POST", post.approved_tiktok_open_id);
    if (typeof result.publish_id !== "string" || !result.publish_id || result.publish_id.length > 64) throw new Error("Missing TikTok publish identifier");
    await getPool().query(
      "UPDATE posts SET tiktok_publish_id = $1, last_error = NULL, updated_at = now() WHERE id = $2 AND status = 'publishing' AND tiktok_publish_id IS NULL",
      [result.publish_id, post.id],
    );
    return "submitted";
  } catch (error) {
    // A lost init response may already have created a TikTok post. Never start it a second time.
    const rejectedLocally = error instanceof ApiError && !(error instanceof TikTokApiError) && [400, 401, 403, 409].includes(error.status);
    if (initializing && !rejectedLocally && (!(error instanceof TikTokApiError) || error.uncertain)) {
      await getPool().query("UPDATE posts SET last_error = $1, updated_at = now() WHERE id = $2 AND status = 'publishing'", [UNCERTAIN, post.id]);
      return "held";
    }
    await failClaim(post.id, error);
    return "failed";
  }
}

async function claimDuePost(): Promise<PublishingPost | null> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const result = await db.query<PublishingPost>(
      `SELECT p.*, m.storage_key FROM posts AS p
       LEFT JOIN media_assets AS m ON m.id = p.media_asset_id AND m.user_id = p.user_id
       WHERE p.status IN ('queued', 'scheduled') AND p.scheduled_at <= now()
         AND p.approved_at IS NOT NULL AND p.approved_tiktok_open_id IS NOT NULL
       ORDER BY p.scheduled_at, p.id LIMIT 1 FOR UPDATE OF p SKIP LOCKED`,
    );
    const post = result.rows[0];
    if (post) {
      await db.query(
        `UPDATE posts SET status = 'publishing', publish_started_at = now(), tiktok_publish_id = NULL,
         tiktok_post_id = NULL, last_error = NULL, last_status_checked_at = NULL, updated_at = now() WHERE id = $1`,
        [post.id],
      );
    }
    await db.query("COMMIT");
    return post ?? null;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
}

function exactPostId(value: unknown): string | null {
  if (typeof value === "string" && /^[1-9]\d{0,30}$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

async function ownedPost(userId: number, postId: string): Promise<PublishingPost> {
  const result = await getPool().query<PublishingPost>("SELECT * FROM posts WHERE id = $1 AND user_id = $2", [postId, userId]);
  if (!result.rows[0]) throw new ApiError(404, "Post not found.");
  return result.rows[0];
}

export async function refreshPostStatus(userId: number, postId: string): Promise<PublishingPost> {
  const post = await ownedPost(userId, postId);
  if (!["publishing", "published"].includes(post.status) || !post.tiktok_publish_id) return post;
  const claimed = await getPool().query<PublishingPost>(
    `UPDATE posts SET last_status_checked_at = now()
     WHERE id = $1 AND user_id = $2 AND tiktok_publish_id = $3
       AND status IN ('publishing', 'published')
       AND (last_status_checked_at IS NULL OR last_status_checked_at < now() - interval '15 seconds') RETURNING *`,
    [postId, userId, post.tiktok_publish_id],
  );
  if (!claimed.rowCount) return ownedPost(userId, postId);
  try {
    const account = await getTikTokAccount(userId);
    if (!post.approved_tiktok_open_id || account.open_id !== post.approved_tiktok_open_id) throw new ApiError(409, "Reconnect the TikTok account that approved this post to check its status.");
    if (!account.scopes.includes("video.publish")) throw new ApiError(403, "Reconnect TikTok and authorize posting to check this post's status.");
    const result = await tikTokApi(userId, "/v2/post/publish/status/fetch/", { publish_id: post.tiktok_publish_id }, "POST", post.approved_tiktok_open_id);
    if (result.status === "PUBLISH_COMPLETE") {
      const ids = result.publicaly_available_post_id;
      const id = Array.isArray(ids) ? ids.map(exactPostId).find(Boolean) ?? null : null;
      await getPool().query(
        `UPDATE posts SET status = 'published', published_at = COALESCE(published_at, now()),
         tiktok_post_id = COALESCE($1, tiktok_post_id), last_error = NULL, updated_at = now()
         WHERE id = $2 AND tiktok_publish_id = $3 AND status IN ('publishing', 'published')`,
        [id, postId, post.tiktok_publish_id],
      );
    } else if (result.status === "FAILED") {
      const reason = typeof result.fail_reason === "string" ? result.fail_reason.replace(/[^a-zA-Z0-9_ -]/g, "").slice(0, 100) : "processing_failed";
      await getPool().query(
        "UPDATE posts SET status = 'failed', approved_at = NULL, last_error = $1, updated_at = now() WHERE id = $2 AND tiktok_publish_id = $3 AND status = 'publishing'",
        [`TikTok could not publish this video (${reason}). Review it before trying again.`, postId, post.tiktok_publish_id],
      );
    } else if (!["PROCESSING_UPLOAD", "PROCESSING_DOWNLOAD"].includes(String(result.status))) {
      throw new ApiError(502, "TikTok returned an unknown processing status. Check again later.");
    } else {
      await getPool().query("UPDATE posts SET last_error = NULL WHERE id = $1 AND tiktok_publish_id = $2", [postId, post.tiktok_publish_id]);
    }
  } catch (error) {
    await getPool().query("UPDATE posts SET last_error = $1 WHERE id = $2 AND tiktok_publish_id = $3", [message(error), postId, post.tiktok_publish_id]);
  }
  return ownedPost(userId, postId);
}

export async function runPublishingTick(options: { budgetMs?: number; maxSubmissions?: number; maxStatusChecks?: number } = {}): Promise<{ submitted: number; checked: number; failed: number; held: number }> {
  const deadline = Date.now() + Math.max(0, Math.min(options.budgetMs ?? 45_000, 120_000));
  const counts = { submitted: 0, checked: 0, failed: 0, held: 0 };
  await getPool().query(
    `UPDATE posts SET last_error = $1 WHERE status = 'publishing' AND tiktok_publish_id IS NULL
     AND publish_started_at < now() - interval '10 minutes' AND last_error IS DISTINCT FROM $1`, [UNCERTAIN],
  );
  if (deliveryConfigured()) {
    const stale = await getPool().query(
      `UPDATE posts SET status = 'failed', approved_at = NULL,
       last_error = 'The planned time passed while publishing was unavailable. Review and reschedule.', updated_at = now()
       WHERE status IN ('queued', 'scheduled') AND approved_at IS NOT NULL
         AND scheduled_at < now() - interval '30 minutes'`,
    );
    counts.failed += stale.rowCount ?? 0;
    for (let i = 0; i < Math.min(options.maxSubmissions ?? 1, 5) && Date.now() < deadline; i += 1) {
      const post = await claimDuePost();
      if (!post) break;
      counts[await submitClaim(post)] += 1;
    }
  }
  if (Date.now() < deadline) {
    const pending = await getPool().query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM posts WHERE tiktok_publish_id IS NOT NULL
         AND (status = 'publishing' OR (status = 'published' AND tiktok_post_id IS NULL))
         AND (last_status_checked_at IS NULL OR last_status_checked_at < now() -
           CASE WHEN status = 'published' THEN interval '6 hours' ELSE interval '1 minute' END)
       ORDER BY CASE WHEN status = 'publishing' THEN 0 ELSE 1 END, last_status_checked_at NULLS FIRST, id LIMIT $1`,
      [Math.max(0, Math.min(options.maxStatusChecks ?? 3, 10))],
    );
    for (const post of pending.rows) {
      if (Date.now() >= deadline) break;
      await refreshPostStatus(Number(post.user_id), post.id);
      counts.checked += 1;
    }
  }
  return counts;
}
