# Postmanager

Postmanager is a TikTok-first creation and publishing workspace for Tanzanian creators. It combines drafts, a posting queue, scheduling, and post analytics with guided AI video generation. Creators should be able to make short narrative or explainer videos without writing AI prompts.

## Creator flow

1. Sign in with a phone number and an SMS verification code, adapting the existing SMS Desk authentication flow.
2. Connect a TikTok account and set preferred posting times.
3. Upload a video or generate one from a format and guided topic inputs. Generation uses predefined GPT prompts and automatically selected background music.
4. Review the video, edit its caption and TikTok posting settings, then save it as a draft, add it to the next queue slot, schedule an exact time, or post now.
5. See publishing status and basic performance for published posts.

## First release

- TikTok only. Drafts stay in Postmanager until the creator chooses to post or schedule them.
- A queue that fills configured posting slots, plus exact-time scheduling. Creators can review or move queued posts back to drafts.
- A planner showing drafts, queued posts, scheduled posts, and publishing results.
- A publishing worker that sends approved posts when due, records failures, and shows the resulting TikTok status.
- A TikTok account page that imports public videos created outside Postmanager and shows their views, likes, comments, and shares.
- Per-post analytics for videos published with Postmanager, with periodic snapshots to show changes over time.
- Guided AI video creation as another way to fill a draft; every generated video remains editable and reviewable before posting.

## Technical direction

- Build the first backend and generation workflow in Python.
- Use Neon PostgreSQL for hosted application data. Keep schema changes and application code in GitHub; keep database credentials out of the repository.
- Adapt SMS Desk's Beem phone verification flow to the new application, with separate credentials and Postmanager-specific user and OTP tables.
- Run the creator-facing API in TypeScript on Netlify Functions, while retaining the Python implementation as a reference and for later long-running publishing or rendering work.
- Store prompt templates in version control so generation behavior can be reviewed and improved.
- Store video files privately in Neon Object Storage; Neon Postgres holds account, draft, queue, publishing, and analytics records.

## Database configuration

The existing `postmanager` Neon project's pooled URL is configured in the ignored `.env` file. Use `DATABASE_URL` for normal application queries. When migrations are introduced, add a direct connection as `DATABASE_URL_UNPOOLED`; schema migrations should use that direct URL. Copy the variable names from `.env.example` and keep their values private.

Migrations live in `db/migrations`. The original authentication, planner, and media migrations are applied on the `postmanager-mvp` development branch and main. Migration `004_publishing.sql` was checked on the isolated `postmanager-publishing-analytics` branch and applied on main. Migration `005_tiktok_account_videos.sql` was checked on an isolated branch and applied to the production branch used by the configured database URL; apply it to other branches before running this version. The ignored `.env` contains a branch-scoped storage credential and locally generated session and token-encryption keys.

## TikTok integration

Direct posting requires TikTok's `video.publish` scope and an approved app; unaudited clients are limited to private posts. Reading a creator's public videos and their counts requires `video.list`. The TikTok account page imports these videos in pages of 20, including posts created outside Postmanager. TikTok does not return private posts or drafts through this API. The posting screen must show a preview, editable text, the available privacy choices, and explicit creator consent. A creator must approve the final post settings before it enters the publishing queue. Postmanager will keep scheduled items in its own queue and call TikTok's Direct Post API when they are due. TikTok's Upload API creates a separate draft in TikTok that the creator must finish there. Available counts include views, likes, comments, and shares; deeper metrics such as watch time are outside this scope.

TikTok's [content sharing guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines) require server-hosted videos to use `PULL_FROM_URL`. The Netlify Edge Function at `/tiktok-media/video.mp4` streams private Neon videos to TikTok without redirects. Each delivery URL has a signed capability valid for two hours, supports byte ranges, and is issued only after publishing approval. The bucket remains private; anyone holding the temporary link can access that video until expiry. Set `TIKTOK_MEDIA_URL_PREFIX` to the site's verified HTTPS origin followed by `/tiktok-media/`, then set `TIKTOK_PUBLISHING_ENABLED=1` to enable delivery and publishing. The verified URL prefix must cover this path. Until TikTok audit, posts require `SELF_ONLY` and the posting account must be private. Set `TIKTOK_APP_AUDITED=1` only after audit; branded content cannot use `SELF_ONLY`.

API references: [Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post), [Content Sharing Guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines), [Video Query](https://developers.tiktok.com/docs/en/tiktok-api-v2-video-query), and [Upload to TikTok](https://developers.tiktok.com/docs/en/content-posting-api-get-started-upload-content).

## Phone authentication reference

SMS Desk already has a Python implementation of Tanzania phone normalization, six-digit OTP generation, Beem delivery, database-backed resend and attempt limits, and signed HTTP-only sessions. Its newer TypeScript version also checks request origin. Reuse those auth-specific patterns, with a new cookie name and session secret. Do not bring over SMS Desk's global SMS credit accounting, assigned sender IDs, or admin routes.

Local source reference: the sibling `smsdesk` repository has the Python flow in `server.py` on `main`, and the TypeScript flow in `src/app.ts` with its tables in `db/schema.sql` on `public`.

## First milestone

Build one complete TikTok workflow: phone sign-in, TikTok connection, a local draft, queue or exact-time scheduling, publishing status, and the four available post metrics. Add guided video generation to that draft flow so AI content uses the same review and scheduling steps.

## Decisions to make

- Postmanager's Beem sender identity and SMS sending budget.
- Which AI, voice, video, and licensed music sources to use.
- Which languages and video formats to support first.
- Where to run the production publishing worker and future video-rendering jobs.
- TikTok developer app approval for publishing and reading video data.
- Whether video rendering should remain a Python worker when the API moves to TypeScript and Netlify.

## Current implementation and local run

The Python app now includes SMS Desk-style Beem phone authentication, TikTok OAuth and creator settings, private MP4 upload with signed previews, draft editing, queue slots, exact-time scheduling, explicit posting approval, and a worker for Direct Post status and basic metrics. AI video creation and licensed music selection remain next-phase work.

The `feat/netlify-serverless` branch provides phone sign-in, TikTok OAuth, private MP4 uploads, drafts, queue times, scheduling, Direct Post publishing, status checks, and public video metrics with history. Private plans retain `approved_at = NULL`. Automatic publishing requires a separate explicit choice and review for the currently connected TikTok account. Existing plans stay on hold until approved. AI generation and music selection remain future work. Use the Netlify worker for this deployment; do not run the Python publishing worker against the same production queue.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m postmanager.server
```

Open `http://127.0.0.1:8000`. Run `.venv/bin/python -m postmanager.worker --loop` separately when TikTok publishing is configured. The app's private video upload limit is 500 MiB.

Phone sign-in needs `BEEM_AUTHORIZATION` in `key:secret` form and `BEEM_SOURCE_ADDR`. Its default `OTP_DAILY_LIMIT` is 1,000 code sends per rolling 24 hours. TikTok connection needs `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, an HTTPS `APP_BASE_URL`, and the registered `/api/tiktok/callback` redirect. The requested scopes are `user.info.basic`, `video.publish`, and `video.list`. The local HTTP URL is for app development; TikTok OAuth needs HTTPS.

## Deploy the Netlify branch

1. In [Netlify](https://app.netlify.com/start), import the GitHub repository `Johnndelembi/postmanager`. Select `feat/netlify-serverless` as the production branch for the first site. The repo's `netlify.toml` sets the build command, `public` directory, API rewrite, and Functions directory. `.nvmrc` selects Node 24.
2. In **Project configuration → Environment variables**, add `DATABASE_URL`, `SESSION_SECRET`, `BEEM_SOURCE_ADDR`, and `BEEM_AUTHORIZATION` from your ignored local `.env` file. For Neon storage, use **Netlify-safe names**: `NEON_STORAGE_ACCESS_KEY_ID` gets the value of local `AWS_ACCESS_KEY_ID`; `NEON_STORAGE_SECRET_ACCESS_KEY` gets `AWS_SECRET_ACCESS_KEY`; `NEON_STORAGE_ENDPOINT_URL_S3` gets `AWS_ENDPOINT_URL_S3`; and `NEON_STORAGE_REGION` gets `AWS_REGION`. Netlify reserves the `AWS_*` names. For TikTok, set `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, and `TOKEN_ENCRYPTION_KEY`. Set `TIKTOK_SCOPES=video.publish,video.list` for publishing and analytics (also the default when unset); set it to an empty value for basic profile access only. TikTok must grant those scopes, and creators must reconnect to grant newly requested permissions. Set `TIKTOK_MEDIA_URL_PREFIX` to your verified site origin followed by `/tiktok-media/` and `TIKTOK_PUBLISHING_ENABLED=1` when ready to send approved posts. These variables need **Functions** scope and **Production** context, including the signing secret used by the Edge Function. Mark credentials as **secret**; public URLs, regions, and feature switches are configuration values. `APP_BASE_URL` is unused by Netlify and can be removed there. Never put credentials in `netlify.toml` or GitHub.
3. Deploy. Open `https://<your-site>.netlify.app/api/health`; it returns `{"ok":true}` when the Function reaches Neon. Then open the site, sign in by SMS, upload an MP4, save a draft, and add it to the queue or schedule it. The video goes straight from the browser to the private Neon `videos` bucket through a short-lived signed URL, because Netlify Functions cannot accept a 500 MB upload body.

The deploy also serves public pages at `/about/`, `/privacy/`, and `/terms/`. Use `/about/` as the TikTok app's Website URL and the other two as its Privacy Policy and Terms of Service URLs. Their links are visible on the About page. TikTok requires a public product website rather than a login screen and requires URL ownership verification before app review; see its [app review guidelines](https://developers.tiktok.com/docs/en/app-review-guidelines) and [app registration guide](https://developers.tiktok.com/docs/en/getting-started-create-an-app).

Register `https://<your-site>.netlify.app/api/tiktok/callback` as the TikTok Login Kit redirect URI. The existing bucket CORS rule permits signed browser uploads. Narrow allowed origins to the exact site origin and any preview/local origins you use. A single PUT supports the current 500 MB cap, but uploads above 100 MB cannot resume yet, and abandoned uploads have no cleanup job.

## Publishing and analytics operations

- Netlify deploys `publisher-schedule` once per minute on the production site. It authenticates a request to `publisher-background`, which submits due approved posts and polls TikTok status. Background Functions must be available on your Netlify plan. Netlify schedules are approximate: Publish now means the next worker pass, and queue/schedule times use East Africa Time.
- Plans created before enabling publishing remain private. Choose automatic publishing or approve an existing future plan to grant consent. Approval is tied to the TikTok account that was reviewed; changing accounts requires review again. Failed attempts require another creator review. Plans more than 30 minutes overdue are returned as failed for review instead of posting unexpectedly.
- The worker claims a post before calling TikTok. If TikTok may have accepted the request but no publish ID was received, it holds the post with an uncertainty message and never submits it again automatically. Check TikTok and contact the operator to reconcile that outcome before creating a replacement.
- `POST /api/posts/:id/status` refreshes a post's status with a 15-second cooldown. TikTok processing may take a few minutes. Private posts can complete without a public video ID.
- `GET /api/analytics` returns totals, per-post counts, last successful sync, and up to 30 snapshots per post for the latest 100 published posts. Totals include all stored published posts. `POST /api/analytics/refresh` checks up to 20 eligible videos with a one-minute cooldown. The worker refreshes one eligible Postmanager-published batch per minute, with each video's automatic sync due every six hours.
- `GET /api/tiktok/videos` returns the connected account's imported public videos. `POST /api/tiktok/videos/sync` refreshes the newest page or imports the next older page; `POST /api/tiktok/videos/metrics` refreshes counts for up to 20 older cached videos. TikTok's list endpoint returns at most 20 videos per call. Cover URLs expire, so the metrics endpoint also refreshes them when possible.
- The account page shows videos created outside Postmanager and Postmanager-published videos when TikTok returns them. It keeps the two analytics sources separate. Private, unavailable, or not-yet-public videos may have no counts; missing responses preserve the last known counts and show an unavailable message. Watch time and audience demographics are outside this scope.
- Check Netlify Function logs for `publisher-schedule` dispatch errors and `publisher-background` summaries. The default publishing flag is off; keep it off while app permissions or verified media delivery are incomplete.

The repo's `.codex/config.toml` connects the Neon MCP server, and `AGENTS.md` records the branch-first workflow from the [Neon agent setup guide](https://neon.com/prompts/agent-setup.md).
