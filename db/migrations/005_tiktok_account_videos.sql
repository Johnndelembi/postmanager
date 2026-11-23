CREATE TABLE IF NOT EXISTS tiktok_account_videos (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  open_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  create_time TIMESTAMPTZ NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  video_description TEXT NOT NULL DEFAULT '',
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  cover_image_url TEXT,
  share_url TEXT,
  embed_link TEXT,
  view_count BIGINT CHECK (view_count IS NULL OR view_count >= 0),
  like_count BIGINT CHECK (like_count IS NULL OR like_count >= 0),
  comment_count BIGINT CHECK (comment_count IS NULL OR comment_count >= 0),
  share_count BIGINT CHECK (share_count IS NULL OR share_count >= 0),
  metrics_synced_at TIMESTAMPTZ,
  metrics_checked_at TIMESTAMPTZ,
  metrics_error TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, open_id, video_id)
);

CREATE INDEX IF NOT EXISTS tiktok_account_videos_user_time
  ON tiktok_account_videos (user_id, open_id, create_time DESC, video_id DESC);

CREATE TABLE IF NOT EXISTS tiktok_video_sync_state (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  open_id TEXT NOT NULL,
  next_cursor BIGINT,
  has_more BOOLEAN NOT NULL DEFAULT true,
  initialized_at TIMESTAMPTZ,
  latest_checked_at TIMESTAMPTZ,
  sync_lease_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, open_id)
);
