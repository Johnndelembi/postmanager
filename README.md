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
- Per-post analytics for views, likes, comments, and shares, with periodic snapshots to show changes over time.
- Guided AI video creation as another way to fill a draft; every generated video remains editable and reviewable before posting.

## Technical direction

- Build the first backend and generation workflow in Python.
- Use Neon PostgreSQL for hosted application data. Keep schema changes and application code in GitHub; keep database credentials out of the repository.
- Adapt SMS Desk's Beem phone verification flow to the new application, with separate credentials and Postmanager-specific user and OTP tables.
- Plan a later TypeScript implementation for Netlify serverless deployment. Check video rendering and job duration against serverless limits before moving that work.
- Store prompt templates in version control so generation behavior can be reviewed and improved.
- Store video files privately in Neon Object Storage; Neon Postgres holds account, draft, queue, publishing, and analytics records.

## Database configuration

The existing `postmanager` Neon project's pooled URL is configured in the ignored `.env` file. Use `DATABASE_URL` for normal application queries. When migrations are introduced, add a direct connection as `DATABASE_URL_UNPOOLED`; schema migrations should use that direct URL. Copy the variable names from `.env.example` and keep their values private.

Migrations `001_auth.sql`, `002_planner.sql`, and `003_media.sql` have been applied to the `postmanager-mvp` development branch and the main branch. Both branches have a private `videos` bucket. The ignored `.env` also contains a branch-scoped production storage credential and locally generated session and token-encryption keys.

## TikTok integration

Direct posting requires TikTok's `video.publish` scope and an approved app; unaudited clients are limited to private posts. Reading a creator's public video metrics requires `video.list`. The posting screen must show a preview, editable text, the available privacy choices, and explicit creator consent. A creator must approve the final post settings before it enters the publishing queue. Postmanager will keep scheduled items in its own queue and call TikTok's Direct Post API when they are due. TikTok's Upload API creates a separate draft in TikTok that the creator must finish there. The initial analytics view covers counts available through TikTok's video query; deeper metrics such as watch time are outside this scope.

TikTok's [content sharing guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines) require server-hosted videos to use `PULL_FROM_URL`; `FILE_UPLOAD` is for videos on a creator's device. The worker holds queued posts until `TIKTOK_MEDIA_URL_PREFIX` points to an HTTPS domain or URL prefix verified in TikTok developer settings. That prefix must serve each stored `users/<user-id>/<random-id>.mp4` object without redirects and remain reachable during TikTok's download window. A delivery gateway for this domain has not been built because the project does not have a domain yet. Keep the prefix unset until it is working. Private preview URLs cannot be used for TikTok delivery. Until the app passes TikTok audit, approved posts require `SELF_ONLY` and the posting account must be private. Set `TIKTOK_APP_AUDITED=1` only after audit; branded content cannot use `SELF_ONLY`.

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

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m postmanager.server
```

Open `http://127.0.0.1:8000`. Run `.venv/bin/python -m postmanager.worker --loop` separately when TikTok publishing is configured. The app's private video upload limit is 500 MiB.

Only Neon is fully configured so far. Phone sign-in needs `BEEM_AUTHORIZATION` in `key:secret` form and `BEEM_SOURCE_ADDR`. Its default `OTP_DAILY_LIMIT` is 1,000 code sends per rolling 24 hours. TikTok connection needs `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, an HTTPS `APP_BASE_URL`, and the registered `/api/tiktok/callback` redirect. The requested scopes are `user.info.basic`, `video.publish`, and `video.list`. The local HTTP URL is for app development; TikTok OAuth needs HTTPS.

The repo's `.codex/config.toml` connects the Neon MCP server, and `AGENTS.md` records the branch-first workflow from the [Neon agent setup guide](https://neon.com/prompts/agent-setup.md).
