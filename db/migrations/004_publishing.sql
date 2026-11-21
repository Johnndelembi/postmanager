ALTER TABLE tiktok_accounts ADD COLUMN IF NOT EXISTS granted_scopes TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE posts ADD COLUMN IF NOT EXISTS approved_tiktok_open_id TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS publish_started_at TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS last_status_checked_at TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS analytics_checked_at TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS analytics_error TEXT;

CREATE INDEX IF NOT EXISTS posts_publishing_status_check ON posts(last_status_checked_at NULLS FIRST)
  WHERE status = 'publishing';
CREATE INDEX IF NOT EXISTS posts_analytics_check ON posts(analytics_checked_at NULLS FIRST)
  WHERE status = 'published' AND tiktok_post_id IS NOT NULL;
