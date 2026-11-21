import type { PoolClient } from "pg";

import { getPool } from "./db.js";
import { ApiError, json } from "./http.js";
import { checkApprovalAccount, publishingApproval, refreshPostStatus, validatePostForPublishing, type PublishingPost } from "./publishing.js";

const TIMEZONE = "Africa/Dar_es_Salaam";
const DEFAULT_QUEUE_TIMES = ["09:00", "18:00"];
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_POST_ID = 9223372036854775807n;
const PRIVACY_LEVELS = new Set(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]);
const BOOLEAN_FIELDS = ["allow_comment", "allow_duet", "allow_stitch", "is_aigc", "brand_organic_toggle", "brand_content_toggle"] as const;
const POST_FIELDS = ["title", "caption", "media_asset_id", "duration_seconds", "privacy_level", ...BOOLEAN_FIELDS] as const;

type PostRow = PublishingPost;

function publicPost(post: PostRow) {
  return { ...post, preview_url: post.media_asset_id ? `/api/media/${post.media_asset_id}/preview` : null };
}

async function payload(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ApiError(415, "Send JSON with Content-Type: application/json.");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 1_000_000) {
    throw new ApiError(413, "Request is too large.");
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.");
  }
  throw new ApiError(400, "Request body must be a JSON object.");
}

function positiveId(value: unknown): string {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== "string" || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > MAX_POST_ID) {
    throw new ApiError(400, "Choose an uploaded video.");
  }
  return id;
}

function postFields(data: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const key of POST_FIELDS) {
    if (!(key in data)) continue;
    const value = data[key];
    if (key === "title") {
      if (typeof value !== "string" || value.length > 200) throw new ApiError(400, "Title must be 200 characters or fewer.");
      values[key] = value.trim();
    } else if (key === "caption") {
      if (typeof value !== "string" || value.length > 2200) throw new ApiError(400, "Caption is too long for TikTok.");
      values[key] = value.trim();
    } else if (key === "media_asset_id") {
      values[key] = value === null || value === "" ? null : positiveId(value);
    } else if (key === "duration_seconds") {
      if (value !== null && value !== "" && (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 36000)) {
        throw new ApiError(400, "Video duration must be a positive number of seconds.");
      }
      values[key] = value === "" ? null : value;
    } else if (key === "privacy_level") {
      if (value !== null && value !== "" && (typeof value !== "string" || !PRIVACY_LEVELS.has(value))) {
        throw new ApiError(400, "Choose a valid TikTok privacy setting.");
      }
      values[key] = value === "" ? null : value;
    } else {
      if (typeof value !== "boolean") throw new ApiError(400, `${key} must be true or false.`);
      values[key] = value;
    }
  }
  return values;
}

async function checkMediaOwner(db: PoolClient, userId: number, mediaId: unknown): Promise<void> {
  if (mediaId === null || mediaId === undefined) return;
  const result = await db.query("SELECT 1 FROM media_assets WHERE id = $1 AND user_id = $2 FOR KEY SHARE", [mediaId, userId]);
  if (!result.rowCount) throw new ApiError(400, "Choose a video uploaded to your account.");
}

async function ownedPost(db: PoolClient, userId: number, postId: string): Promise<PostRow> {
  const result = await db.query<PostRow>("SELECT * FROM posts WHERE id = $1 AND user_id = $2 FOR UPDATE", [postId, userId]);
  if (!result.rows[0]) throw new ApiError(404, "Post not found.");
  return result.rows[0];
}

async function transaction<T>(run: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const result = await run(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

function validateQueueTimes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    throw new ApiError(400, "Choose between one and twelve posting times.");
  }
  if (!value.every((slot) => typeof slot === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot))) {
    throw new ApiError(400, "Posting times must use HH:MM in 24-hour format.");
  }
  if (new Set(value).size !== value.length) throw new ApiError(400, "Posting times must be unique.");
  return [...value].sort();
}

// Tanzania uses UTC+03:00 year-round, so each configured HH:MM has one UTC instant.
export function nextQueueTime(now: Date, queueTimes: string[], reserved: Iterable<Date | string>): Date {
  const local = new Date(now.getTime() + EAT_OFFSET_MS);
  const localDay = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const occupied = new Set(Array.from(reserved, (value) => new Date(value).getTime()));
  const slots = validateQueueTimes(queueTimes);
  for (let day = 0; day < 366; day += 1) {
    for (const slot of slots) {
      const [hour, minute] = slot.split(":").map(Number);
      const candidate = localDay + day * DAY_MS + (hour * 60 + minute) * 60_000 - EAT_OFFSET_MS;
      if (candidate > now.getTime() && !occupied.has(candidate)) return new Date(candidate);
    }
  }
  throw new ApiError(409, "No queue slot is available in the next year.");
}

function scheduledTime(value: unknown, now: Date): Date {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new ApiError(400, "Scheduled time must include a valid date and timezone.");
  }
  const when = new Date(value);
  if (!Number.isFinite(when.getTime())) throw new ApiError(400, "Choose a valid date and time.");
  if (when.getTime() <= now.getTime()) throw new ApiError(400, "Scheduled time must be in the future.");
  return when;
}

async function listPosts(userId: number): Promise<Response> {
  const result = await getPool().query<PostRow>(
    "SELECT * FROM posts WHERE user_id = $1 ORDER BY COALESCE(scheduled_at, created_at) DESC, id DESC",
    [userId],
  );
  return json(200, { posts: result.rows.map(publicPost) });
}

async function createPost(userId: number, data: Record<string, unknown>): Promise<Response> {
  const values = postFields(data);
  const post = await transaction(async (db) => {
    await checkMediaOwner(db, userId, values.media_asset_id);
    const result = await db.query<PostRow>(
      `INSERT INTO posts
       (user_id, title, caption, media_asset_id, duration_seconds, privacy_level,
        allow_comment, allow_duet, allow_stitch, is_aigc, brand_organic_toggle, brand_content_toggle)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [userId, values.title ?? "", values.caption ?? "", values.media_asset_id ?? null,
        values.duration_seconds ?? null, values.privacy_level ?? null, values.allow_comment ?? false,
        values.allow_duet ?? false, values.allow_stitch ?? false, values.is_aigc ?? false,
        values.brand_organic_toggle ?? false, values.brand_content_toggle ?? false],
    );
    return result.rows[0];
  });
  return json(201, publicPost(post));
}

async function updatePost(userId: number, postId: string, data: Record<string, unknown>): Promise<Response> {
  const values = postFields(data);
  const fields = Object.keys(values);
  if (!fields.length) throw new ApiError(400, "No post fields were provided.");
  const post = await transaction(async (db) => {
    const current = await ownedPost(db, userId, postId);
    if (current.status !== "draft" && current.status !== "failed") {
      throw new ApiError(409, "Move this post back to drafts before editing it.");
    }
    if ("media_asset_id" in values) await checkMediaOwner(db, userId, values.media_asset_id);
    const assignments = fields.map((field, index) => `${field} = $${index + 1}`).join(", ");
    const result = await db.query<PostRow>(
      `UPDATE posts SET ${assignments}, updated_at = now(), last_error = NULL,
       approved_at = NULL, approved_tiktok_open_id = NULL, tiktok_publish_id = NULL,
       tiktok_post_id = NULL, publish_started_at = NULL, last_status_checked_at = NULL
       WHERE id = $${fields.length + 1} RETURNING *`,
      [...fields.map((field) => values[field]), postId],
    );
    return result.rows[0];
  });
  return json(200, publicPost(post));
}

async function deletePost(userId: number, postId: string): Promise<Response> {
  await transaction(async (db) => {
    const current = await ownedPost(db, userId, postId);
    if (current.status === "publishing" || current.status === "published") {
      throw new ApiError(409, "A post already sent to TikTok cannot be deleted here.");
    }
    await db.query("DELETE FROM posts WHERE id = $1", [postId]);
  });
  return json(200, { ok: true });
}

async function draftPost(userId: number, postId: string): Promise<Response> {
  const post = await transaction(async (db) => {
    const current = await ownedPost(db, userId, postId);
    if (current.status === "publishing" || current.status === "published") {
      throw new ApiError(409, "This post has already been sent to TikTok.");
    }
    const result = await db.query<PostRow>(
      `UPDATE posts SET status = 'draft', scheduled_at = NULL, approved_at = NULL,
       approved_tiktok_open_id = NULL, tiktok_publish_id = NULL, tiktok_post_id = NULL,
       publish_started_at = NULL, last_status_checked_at = NULL,
       last_error = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
      [postId],
    );
    return result.rows[0];
  });
  return json(200, publicPost(post));
}

async function planPost(userId: number, postId: string, action: "queue" | "schedule" | "publish", data: Record<string, unknown>): Promise<Response> {
  if (data.approved !== true) throw new ApiError(400, "Review the post before adding it to your plan.");
  if ("publish_to_tiktok" in data && typeof data.publish_to_tiktok !== "boolean") throw new ApiError(400, "Choose whether this plan should publish to TikTok.");
  const sendToTikTok = action === "publish" || data.publish_to_tiktok === true;
  const approval = sendToTikTok ? await publishingApproval(userId) : null;
  try {
    const post = await transaction(async (db) => {
      await db.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      const current = await ownedPost(db, userId, postId);
      if (current.status !== "draft" && current.status !== "failed") {
        throw new ApiError(409, "Move this post back to drafts before planning it again.");
      }
      if (!current.media_asset_id || !current.duration_seconds) {
        throw new ApiError(400, "Upload a video and confirm its duration before scheduling.");
      }
      if (approval) {
        validatePostForPublishing(current, approval.creator);
        await checkApprovalAccount(db, userId, approval.openId);
      }
      const now = new Date();
      let when: Date;
      if (action === "queue") {
        const settings = await db.query<{ queue_times: string[] }>("SELECT queue_times FROM user_settings WHERE user_id = $1", [userId]);
        const reserved = await db.query<{ scheduled_at: Date }>(
          "SELECT scheduled_at FROM posts WHERE user_id = $1 AND status IN ('queued', 'scheduled') AND scheduled_at > $2",
          [userId, now],
        );
        when = nextQueueTime(now, settings.rows[0]?.queue_times ?? DEFAULT_QUEUE_TIMES, reserved.rows.map((row) => row.scheduled_at));
      } else if (action === "schedule") {
        when = scheduledTime(data.scheduled_at, now);
        const taken = await db.query(
          "SELECT 1 FROM posts WHERE user_id = $1 AND status IN ('queued', 'scheduled') AND scheduled_at = $2 LIMIT 1",
          [userId, when],
        );
        if (taken.rowCount) throw new ApiError(409, "Another post already uses that time.");
      } else when = now;
      const result = await db.query<PostRow>(
        `UPDATE posts SET status = $1, scheduled_at = $2, approved_at = $3,
         approved_tiktok_open_id = $4, tiktok_publish_id = NULL, tiktok_post_id = NULL,
         publish_started_at = NULL, last_status_checked_at = NULL, last_error = NULL,
         updated_at = now() WHERE id = $5 RETURNING *`,
        [action === "schedule" ? "scheduled" : "queued", when, approval ? now : null, approval?.openId ?? null, postId],
      );
      return result.rows[0];
    });
    return json(action === "publish" ? 202 : 200, publicPost(post));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      throw new ApiError(409, "Another post already uses that time.");
    }
    throw error;
  }
}

async function approvePlannedPost(userId: number, postId: string, data: Record<string, unknown>): Promise<Response> {
  if (data.approved !== true) throw new ApiError(400, "Review the post and approve TikTok publishing first.");
  const approval = await publishingApproval(userId);
  const post = await transaction(async (db) => {
    const current = await ownedPost(db, userId, postId);
    if (!["queued", "scheduled"].includes(current.status)) throw new ApiError(409, "Only a queued or scheduled private plan can be approved here.");
    if (!current.scheduled_at || new Date(String(current.scheduled_at)).getTime() <= Date.now()) {
      throw new ApiError(409, "The planned time has passed. Move this post to drafts and choose a future time.");
    }
    validatePostForPublishing(current, approval.creator);
    await checkApprovalAccount(db, userId, approval.openId);
    const result = await db.query<PostRow>(
      "UPDATE posts SET approved_at = now(), approved_tiktok_open_id = $1, last_error = NULL, updated_at = now() WHERE id = $2 RETURNING *",
      [approval.openId, postId],
    );
    return result.rows[0];
  });
  return json(200, publicPost(post));
}

async function getSettings(userId: number): Promise<Response> {
  const result = await getPool().query<{ timezone: string; queue_times: string[] }>(
    "SELECT timezone, queue_times FROM user_settings WHERE user_id = $1",
    [userId],
  );
  return json(200, result.rows[0] ?? { timezone: TIMEZONE, queue_times: DEFAULT_QUEUE_TIMES });
}

async function putSettings(userId: number, data: Record<string, unknown>): Promise<Response> {
  const times = validateQueueTimes(data.queue_times);
  const result = await getPool().query<{ timezone: string; queue_times: string[] }>(
    `INSERT INTO user_settings(user_id, timezone, queue_times) VALUES ($1, $2, $3)
     ON CONFLICT(user_id) DO UPDATE SET queue_times = EXCLUDED.queue_times, updated_at = now()
     RETURNING timezone, queue_times`,
    [userId, TIMEZONE, times],
  );
  return json(200, result.rows[0]);
}

export async function handlePlanner(request: Request, userId: number): Promise<Response> {
  const path = new URL(request.url).pathname;
  const method = request.method.toUpperCase();
  if (path === "/api/posts") {
    if (method === "GET") return listPosts(userId);
    if (method === "POST") return createPost(userId, await payload(request));
    throw new ApiError(405, "Method not allowed.");
  }
  if (path === "/api/settings") {
    if (method === "GET") return getSettings(userId);
    if (method === "PUT") return putSettings(userId, await payload(request));
    throw new ApiError(405, "Method not allowed.");
  }
  const match = /^\/api\/posts\/([1-9]\d*)(?:\/(queue|schedule|draft|publish|approve|status))?$/.exec(path);
  if (!match) throw new ApiError(404, "Route not found.");
  const [, postId, action] = match;
  if (!action) {
    if (method === "PATCH") return updatePost(userId, postId, await payload(request));
    if (method === "DELETE") return deletePost(userId, postId);
    throw new ApiError(405, "Method not allowed.");
  }
  if (method !== "POST") throw new ApiError(405, "Method not allowed.");
  if (action === "draft") return draftPost(userId, postId);
  if (action === "status") return json(200, publicPost(await refreshPostStatus(userId, postId)));
  if (action === "approve") return approvePlannedPost(userId, postId, await payload(request));
  return planPost(userId, postId, action as "queue" | "schedule" | "publish", await payload(request));
}
