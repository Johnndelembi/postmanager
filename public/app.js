"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  posts: null,
  postsError: "",
  filter: "all",
  editingId: null,
  editingPreviewUrl: "",
  editingDuration: null,
  previewObjectUrl: "",
  uploadedMedia: null,
  mediaConfigured: false,
  mediaStatusError: "",
  phone: "",
  tiktok: { connected: false, configured: true },
  creatorInfo: null,
  analytics: null,
  analyticsError: "",
  accountVideos: null,
  accountVideoSummary: null,
  accountVideoAvailable: false,
  accountVideoReason: "",
  accountVideoHasCachedMore: false,
  accountVideoHasRemoteMore: false,
  accountVideoInitialized: false,
  accountVideoError: "",
  accountVideoAutoStarted: false,
  accountVideoSyncing: false,
  settings: { timezone: "Africa/Dar_es_Salaam", queue_times: [] },
};
let plannerPoll;
let plannerLoading = false;

const privacyNames = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};
const numberFormat = new Intl.NumberFormat("en-TZ");
const dateFormat = new Intl.DateTimeFormat("en-TZ", {
  timeZone: "Africa/Dar_es_Salaam",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

async function api(path, options = {}) {
  const headers = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(path, {
      method: options.method || "GET",
      credentials: "same-origin",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new Error("The server could not be reached. Check your connection and try again.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error && typeof data.error === "object" ? data.error.message : data.error;
    const error = new Error(detail || data.message || "The request could not be completed.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function message(id, text = "", kind = "") {
  const node = $(id);
  node.textContent = text;
  node.className = "message" + (kind ? " " + kind : "");
  if (id === "workspaceMessage") node.classList.add("workspace-message");
}

function show(view) {
  $("loadingView").hidden = view !== "loading";
  $("authView").hidden = view !== "auth";
  $("appView").hidden = view !== "app";
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function safePreviewUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin && !url.username && !url.password && !url.hash
      ? url.href : "";
  } catch {
    return "";
  }
}

function formattedDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : dateFormat.format(date) + " EAT";
}

function metric(value) {
  return value === null || value === undefined ? "—" : numberFormat.format(Number(value));
}

function accountMetric(value) {
  if (value === null || value === undefined) return "—";
  try { return numberFormat.format(BigInt(value)); } catch { return "—"; }
}

async function start() {
  try {
    const user = await api("/api/me");
    $("accountPhone").textContent = user.phone || "";
    show("app");
    await Promise.allSettled([loadTikTok(), loadMediaStatus(), loadSettings(), loadPosts(), loadAnalytics(), loadTikTokVideos(true)]);
  } catch (error) {
    show("auth");
    if (error.status !== 401) message("authMessage", error.message, "error");
  }
}

async function loadTikTok() {
  try {
    state.tiktok = await api("/api/tiktok/status");
    const status = $("tiktokStatus");
    const connect = $("connectTikTok");
    if (state.tiktok.configured === false) {
      status.textContent = "Plan privately for now. TikTok connection needs app credentials and a registered callback URL. Planned posts will stay on hold until publishing is ready.";
      connect.hidden = true;
      state.creatorInfo = null;
    } else if (state.tiktok.connected) {
      const name = state.tiktok.username || state.tiktok.nickname;
      status.textContent = name ? "Connected: " + name : "TikTok connected.";
      if (state.tiktok.publishing_ready !== true) {
        status.textContent += state.tiktok.reconnect_required
          ? " Reconnect to grant publishing and analytics access after TikTok approves those permissions."
          : " Publishing is on hold until TikTok permissions and video delivery are ready. Private planning is available.";
      } else if (state.tiktok.audited !== true) {
        status.textContent += " Until TikTok's audit is complete, posting uses Only me and your TikTok account must be private.";
      }
      connect.textContent = "Reconnect TikTok";
      connect.hidden = false;
      if (state.tiktok.creator_info_ready) await loadCreatorInfo();
      else {
        state.creatorInfo = null;
        applyCreatorInfo();
      }
    } else {
      status.textContent = "Connect TikTok to publish approved videos and sync public post performance.";
      connect.textContent = "Connect TikTok";
      connect.hidden = false;
      state.creatorInfo = null;
    }
    renderPosts();
    renderAnalytics();
    applyCreatorInfo();
  } catch (error) {
    $("tiktokStatus").textContent = "TikTok status is unavailable. " + error.message;
    $("connectTikTok").hidden = false;
    state.creatorInfo = null;
    applyCreatorInfo();
  }
}

async function loadTikTokVideos(autoImport = false) {
  try {
    const data = await api("/api/tiktok/videos?offset=0");
    state.accountVideos = Array.isArray(data.videos) ? data.videos : [];
    state.accountVideoSummary = data.summary || null;
    state.accountVideoAvailable = data.available === true;
    state.accountVideoReason = data.reason || "";
    state.accountVideoHasCachedMore = data.page?.has_cached_more === true;
    state.accountVideoHasRemoteMore = data.sync?.has_more === true;
    state.accountVideoInitialized = data.initialized === true;
    state.accountVideoError = "";
    renderTikTokVideos(data);
    if (autoImport && data.available && !data.initialized && !state.accountVideoAutoStarted) {
      state.accountVideoAutoStarted = true;
      await syncTikTokAccountVideos(false);
    }
  } catch (error) {
    state.accountVideos = null;
    state.accountVideoError = error.message;
    renderTikTokVideos();
  }
}

async function loadMediaStatus() {
  try {
    const status = await api("/api/media/status");
    state.mediaConfigured = status.configured === true;
    state.mediaStatusError = "";
    $("videoFile").disabled = !state.mediaConfigured;
  } catch (error) {
    state.mediaConfigured = false;
    state.mediaStatusError = error.message;
    $("videoFile").disabled = true;
  }
  renderMediaHelp();
}

function renderMediaHelp() {
  $("mediaStatus").textContent = state.mediaStatusError
    ? "Video uploads are unavailable: " + state.mediaStatusError
    : !state.mediaConfigured
      ? "Video uploads are not configured yet. You can still save text drafts."
      : state.editingId !== null
        ? "Your current video stays unless you choose a replacement MP4 (up to 500 MB)."
        : "Choose an MP4 video up to 500 MB. The file is stored privately; you choose when to post.";
}

async function loadCreatorInfo() {
  try {
    const result = await api("/api/tiktok/creator-info");
    state.creatorInfo = result.data || result;
    applyCreatorInfo();
    return true;
  } catch (error) {
    state.creatorInfo = null;
    $("tiktokStatus").textContent += " Posting settings are unavailable: " + error.message;
    applyCreatorInfo();
    return false;
  }
}

function applyCreatorInfo() {
  const select = $("privacyLevel");
  const selected = select.value;
  const options = state.creatorInfo && Array.isArray(state.creatorInfo.privacy_level_options)
    ? state.creatorInfo.privacy_level_options : [];
  select.replaceChildren();
  const placeholder = make("option", "", state.tiktok.connected ? "Choose who can watch" : "Choose after connecting TikTok");
  placeholder.value = "";
  select.append(placeholder);
  for (const value of options) {
    if (!privacyNames[value]) continue;
    const option = make("option", "", privacyNames[value]);
    option.value = value;
    select.append(option);
  }
  if (options.includes(selected)) select.value = selected;
  for (const [id, flag] of [
    ["allowComment", "comment_disabled"],
    ["allowDuet", "duet_disabled"],
    ["allowStitch", "stitch_disabled"],
  ]) {
    const input = $(id);
    input.disabled = Boolean(state.creatorInfo && state.creatorInfo[flag]);
    if (input.disabled) input.checked = false;
  }
  const max = Number(state.creatorInfo && state.creatorInfo.max_video_post_duration_sec);
  $("postingAccount").textContent = state.tiktok.connected
    ? "Publishing account: " + creatorName()
    : "Connect TikTok to choose a publishing account.";
  $("privacyHelp").textContent = state.tiktok.connected && state.tiktok.audited !== true
    ? "Choose a TikTok privacy setting. Until the app passes audit, publishing requires Only me and a private TikTok account."
    : "Select who can watch before approving publishing. Private plans do not need a TikTok privacy setting yet.";
  $("durationHelp").textContent = Number.isFinite(max) && max > 0
    ? "Your TikTok account allows videos up to " + numberFormat.format(max) + " seconds. We will fill this from the preview when available."
    : "We will fill this from the video when available. You can enter it yourself.";
  updateCommercialLabel();
}

function creatorName() {
  return state.creatorInfo?.creator_nickname || state.tiktok.username || state.tiktok.nickname || "your connected TikTok account";
}

async function loadSettings() {
  try {
    const result = await api("/api/settings");
    state.settings = result.settings || result;
    renderQueueTimes();
  } catch (error) {
    message("queueMessage", error.message, "error");
  }
}

function addQueueTime(value = "") {
  const row = make("div", "queue-time");
  const input = make("input");
  input.type = "time";
  input.setAttribute("aria-label", "Queue time in East Africa Time");
  input.value = value;
  const remove = make("button", "button button-quiet button-small", "Remove");
  remove.type = "button";
  remove.setAttribute("aria-label", "Remove queue time " + (value || ""));
  remove.addEventListener("click", () => row.remove());
  row.append(input, remove);
  $("queueTimes").append(row);
}

function renderQueueTimes() {
  $("queueTimes").replaceChildren();
  const times = Array.isArray(state.settings.queue_times) ? state.settings.queue_times : [];
  for (const time of times) addQueueTime(time);
  if (!times.length) addQueueTime();
}

async function loadPosts() {
  if (plannerLoading) return;
  plannerLoading = true;
  try {
    const result = await api("/api/posts");
    const posts = Array.isArray(result.posts) ? result.posts : [];
    const changed = JSON.stringify(posts) !== JSON.stringify(state.posts) || Boolean(state.postsError);
    state.posts = posts;
    state.postsError = "";
    if (changed) renderPosts();
    schedulePlannerPoll();
  } catch (error) {
    state.posts = null;
    state.postsError = error.message;
    message("workspaceMessage", error.message, "error");
    renderPosts();
  } finally {
    plannerLoading = false;
  }
}

function schedulePlannerPoll() {
  clearTimeout(plannerPoll);
  const pending = state.posts?.some((post) => post.status === "publishing" ||
    (["queued", "scheduled"].includes(post.status) && post.approved_at));
  if (pending && !$("appView").hidden) {
    plannerPoll = setTimeout(async () => {
      if (!document.hidden) await loadPosts();
      else schedulePlannerPoll();
    }, 20_000);
  }
}

async function loadAnalytics(sync = false) {
  const button = $("refreshAnalytics");
  if (sync) {
    button.disabled = true;
    button.textContent = "Syncing…";
    message("analyticsMessage", "Checking public post metrics with TikTok…");
  }
  try {
    state.analytics = await api(sync ? "/api/analytics/refresh" : "/api/analytics", sync ? { method: "POST", body: {} } : {});
    state.analyticsError = "";
    if (sync) {
      const refresh = state.analytics.refresh || {};
      message("analyticsMessage", refresh.cooldown
        ? "Metrics were checked recently. Try again in " + refresh.retry_after + " seconds."
        : "Metrics updated for " + (refresh.updated || 0) + " public " + (refresh.updated === 1 ? "post" : "posts") + ".", "success");
      await loadPosts();
    }
  } catch (error) {
    state.analyticsError = error.message;
    if (sync) message("analyticsMessage", error.message, "error");
  } finally {
    button.textContent = "Sync Postmanager posts";
    renderAnalytics();
  }
}

function filteredPosts() {
  if (!state.posts) return null;
  if (state.filter === "all") return state.posts;
  if (state.filter === "upcoming") return state.posts
    .filter((post) => ["queued", "scheduled", "publishing"].includes(post.status))
    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
  if (state.filter === "draft") return state.posts.filter((post) => ["draft", "failed"].includes(post.status));
  return state.posts.filter((post) => post.status === state.filter);
}

function renderPosts() {
  const list = $("postsList");
  list.replaceChildren();
  if (state.posts === null) {
    list.append(state.postsError
      ? emptyState("Planner unavailable", "Refresh to try loading your posts again.")
      : emptyState("Loading your planner", "Your drafts and scheduled posts will appear here."));
    $("postCount").textContent = "";
    return;
  }
  $("postCount").textContent = state.posts.length + (state.posts.length === 1 ? " post" : " posts");
  const posts = filteredPosts();
  if (!posts.length) {
    const content = state.filter === "all"
      ? ["Your planner starts here", "Save your first draft above. You can queue it after uploading a video, even before connecting TikTok."]
      : ["Nothing in this view yet", "Posts will appear here as you move them through your planner."];
    list.append(emptyState(content[0], content[1]));
    return;
  }
  for (const post of posts) list.append(postRow(post));
}

function emptyState(title, detail) {
  const node = make("div", "empty-state");
  node.append(make("h3", "", title), make("p", "", detail));
  return node;
}

function safeTikTokUrl(value, hosts) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
    return hosts.some((host) => url.hostname === host || url.hostname.endsWith("." + host)) ? url.href : "";
  } catch {
    return "";
  }
}

function renderTikTokVideos() {
  const summaryHost = $("accountVideoSummary");
  const content = $("accountVideoContent");
  summaryHost.replaceChildren();
  content.replaceChildren();
  const videos = state.accountVideos;
  const summary = state.accountVideoSummary;
  const total = Number(summary?.video_count || 0);
  $("accountVideoCount").textContent = total ? total + (total === 1 ? " public post" : " public posts") : "";
  $("syncAccountVideos").disabled = !state.accountVideoAvailable || state.accountVideoSyncing;
  $("refreshAccountMetrics").disabled = !state.accountVideoAvailable || state.accountVideoSyncing || !total;
  if (state.accountVideoError) {
    content.append(make("p", "account-video-empty", "TikTok posts could not be loaded: " + state.accountVideoError));
    $("loadOlderVideos").hidden = true;
    return;
  }
  if (!state.accountVideoAvailable) {
    content.append(make("p", "account-video-empty", state.accountVideoReason || "Connect TikTok to see your public account posts."));
    $("loadOlderVideos").hidden = true;
    return;
  }
  if (summary) {
    const strip = make("div", "analytics-strip account-video-totals");
    for (const [label, key] of [["Views", "view_count"], ["Likes", "like_count"], ["Comments", "comment_count"], ["Shares", "share_count"]]) {
      const cell = make("div", "analytics-cell");
      cell.append(make("span", "", label), make("strong", "", accountMetric(summary.totals?.[key])));
      strip.append(cell);
    }
    summaryHost.append(strip);
    summaryHost.append(make("p", "analytics-source", "Metrics returned for " + (summary.videos_with_metrics || 0) + " of " + total + " synced public posts." +
      (summary.last_synced_at ? " Last updated " + formattedDate(summary.last_synced_at) + "." : "")));
  }
  if (videos === null) {
    content.append(emptyState("Loading TikTok posts", "Your public account videos will appear here."));
  } else if (!videos.length) {
    content.append(emptyState(state.accountVideoInitialized ? "No public posts found" : "Syncing your account", state.accountVideoInitialized
      ? "TikTok did not return public videos for this account. Private and draft videos are not available through this list."
      : "Postmanager is checking your TikTok account for public videos."));
  } else {
    const grid = make("div", "account-video-grid");
    for (const video of videos) grid.append(accountVideoCard(video));
    content.append(grid);
  }
  $("loadOlderVideos").hidden = !state.accountVideoHasCachedMore && !state.accountVideoHasRemoteMore;
  $("loadOlderVideos").disabled = state.accountVideoSyncing;
}

function accountVideoCard(video) {
  const card = make("article", "account-video-card");
  const coverUrl = safeTikTokUrl(video.cover_image_url, ["tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokcdn-in.com"]);
  if (coverUrl) {
    const image = make("img", "account-video-cover");
    image.src = coverUrl;
    image.alt = "Cover for " + (video.title || video.video_description || "TikTok video");
    image.loading = "lazy";
    image.addEventListener("error", () => image.replaceWith(make("div", "account-video-cover empty", "Preview unavailable")), { once: true });
    card.append(image);
  } else {
    card.append(make("div", "account-video-cover empty", "Preview unavailable"));
  }

  const body = make("div", "account-video-body");
  body.append(make("h3", "", video.title || video.video_description || "TikTok video"));
  body.append(make("p", "account-video-date", formattedDate(video.create_time) || "Date unavailable"));
  const counts = make("div", "account-video-metrics");
  for (const [label, key] of [["Views", "view_count"], ["Likes", "like_count"], ["Comments", "comment_count"], ["Shares", "share_count"]]) {
    const item = make("span");
    item.append(make("strong", "", accountMetric(video[key])), " " + label);
    counts.append(item);
  }
  body.append(counts);
  if (video.metrics_error) body.append(make("p", "post-error", video.metrics_error));
  else if (!video.metrics_synced_at) body.append(make("p", "field-help analytics-note", "TikTok has not returned public counts for this video yet."));
  const actions = make("div", "account-video-actions");
  const embedUrl = safeTikTokUrl(video.embed_link, ["tiktok.com"]);
  if (embedUrl) {
    const toggle = make("button", "button-link", "Play here");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
      const player = body.querySelector("iframe");
      if (player) {
        player.remove();
        toggle.textContent = "Play here";
        toggle.setAttribute("aria-expanded", "false");
      } else {
        const frame = make("iframe", "account-video-player");
        frame.src = embedUrl;
        frame.title = "TikTok video: " + (video.title || video.video_description || "video");
        frame.loading = "lazy";
        frame.referrerPolicy = "strict-origin-when-cross-origin";
        frame.allow = "encrypted-media; fullscreen";
        body.insertBefore(frame, actions);
        toggle.textContent = "Close preview";
        toggle.setAttribute("aria-expanded", "true");
      }
    });
    actions.append(toggle);
  }
  const shareUrl = safeTikTokUrl(video.share_url, ["tiktok.com"]);
  if (shareUrl) {
    const link = make("a", "", "View on TikTok");
    link.href = shareUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    actions.append(link);
  }
  if (actions.childNodes.length) body.append(actions);
  card.append(body);
  return card;
}

async function loadCachedTikTokVideoPage() {
  const offset = state.accountVideos?.length || 0;
  const data = await api("/api/tiktok/videos?offset=" + offset);
  const seen = new Set((state.accountVideos || []).map((video) => video.video_id));
  state.accountVideos = [...(state.accountVideos || []), ...(data.videos || []).filter((video) => !seen.has(video.video_id))];
  state.accountVideoSummary = data.summary || state.accountVideoSummary;
  state.accountVideoHasCachedMore = data.page?.has_cached_more === true;
  state.accountVideoHasRemoteMore = data.sync?.has_more === true;
  state.accountVideoInitialized = data.initialized === true;
  renderTikTokVideos();
  return (data.videos || []).length;
}

async function syncTikTokAccountVideos(older = false) {
  const button = older ? $("loadOlderVideos") : $("syncAccountVideos");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = older ? "Loading…" : "Syncing…";
  state.accountVideoSyncing = true;
  if (!older) message("accountSyncMessage", "Checking your public TikTok posts…");
  renderTikTokVideos();
  try {
    if (older && state.accountVideoHasCachedMore) {
      const loaded = await loadCachedTikTokVideoPage();
      message("accountSyncMessage", loaded ? "Loaded " + loaded + " older posts already synced from TikTok." : "No more cached posts.", "success");
      return;
    }
    if (older && !state.accountVideoHasRemoteMore) {
      message("accountSyncMessage", "There are no older public posts to load.");
      return;
    }
    const result = await api("/api/tiktok/videos/sync", { method: "POST", body: { older } });
    const sync = result.sync || {};
    if (older) {
      if (sync.no_more) {
        state.accountVideoHasRemoteMore = false;
        message("accountSyncMessage", "There are no older public posts to load.");
      } else if (sync.busy) {
        message("accountSyncMessage", "An older-post sync is already in progress. Try again in a moment.");
      } else {
        const loaded = await loadCachedTikTokVideoPage();
        message("accountSyncMessage", loaded
          ? "Loaded " + loaded + " older TikTok posts."
          : "TikTok did not return any older public posts.", "success");
      }
    } else {
      await loadTikTokVideos(false);
      if (sync.cooldown) {
        message("accountSyncMessage", "TikTok posts were checked recently. Try again in " + sync.retry_after + " seconds.");
      } else if (sync.busy) {
        message("accountSyncMessage", "A TikTok sync is already in progress. Refresh this page in a moment.");
      } else if (!sync.checked && sync.no_more) {
        message("accountSyncMessage", "TikTok did not return public posts for this account.");
      } else {
        const count = Number(sync.checked || 0);
        message("accountSyncMessage", count
          ? "Synced " + count + " recent TikTok " + (count === 1 ? "post" : "posts") + ". Load older posts to continue browsing your account history."
          : "Your account posts are up to date.", "success");
      }
    }
  } catch (error) {
    message("accountSyncMessage", error.message, "error");
  } finally {
    state.accountVideoSyncing = false;
    button.disabled = false;
    button.textContent = original;
    renderTikTokVideos();
  }
}

async function refreshTikTokAccountMetrics() {
  const button = $("refreshAccountMetrics");
  state.accountVideoSyncing = true;
  renderTikTokVideos();
  const visibleCount = state.accountVideos?.length || 0;
  message("accountSyncMessage", "Refreshing counts for your synced account videos…");
  try {
    const result = await api("/api/tiktok/videos/metrics", { method: "POST", body: {} });
    const refresh = result.refresh || {};
    await loadTikTokVideos(false);
    while ((state.accountVideos?.length || 0) < visibleCount && state.accountVideoHasCachedMore) {
      const loaded = await loadCachedTikTokVideoPage();
      if (!loaded) break;
    }
    if (refresh.cooldown) message("accountSyncMessage", "Account post metrics were checked recently. Try again in " + refresh.retry_after + " seconds.");
    else if (refresh.no_posts) message("accountSyncMessage", "Sync your account posts first to load public videos.");
    else message("accountSyncMessage", "Refreshed metrics for " + (refresh.updated || 0) + " of " + (refresh.checked || 0) + " account posts." +
      (refresh.unavailable ? " TikTok did not return counts for " + refresh.unavailable + "." : ""), "success");
  } catch (error) {
    message("accountSyncMessage", error.message, "error");
  } finally {
    state.accountVideoSyncing = false;
    button.disabled = false;
    renderTikTokVideos();
  }
}

function showWorkspacePage(page) {
  const account = page === "account";
  $("plannerPage").hidden = account;
  $("accountPage").hidden = !account;
  $("showPlannerPage").classList.toggle("active", !account);
  $("showPlannerPage").setAttribute("aria-pressed", String(!account));
  $("showAccountPage").classList.toggle("active", account);
  $("showAccountPage").setAttribute("aria-pressed", String(account));
  if (account && state.accountVideos === null) loadTikTokVideos(true);
}

function readinessIssue(post) {
  if (!post.media_asset_id) return "Upload an MP4 video before posting.";
  if (!safePreviewUrl(post.preview_url)) return "Video preview is unavailable. Refresh and try again.";
  const duration = Number(post.duration_seconds);
  if (!Number.isFinite(duration) || duration <= 0) return "Add the video length before posting.";
  return "";
}

function publishingIssue(post) {
  const issue = readinessIssue(post);
  if (issue) return issue;
  if (!state.tiktok.connected) return "Connect TikTok before publishing.";
  if (state.tiktok.publishing_ready !== true) return "Publishing needs approved TikTok permissions and configured video delivery. You can save a private plan.";
  if (!state.creatorInfo) return "TikTok posting settings are unavailable. Refresh the page and try again.";
  const duration = Number(post.duration_seconds);
  const max = Number(state.creatorInfo.max_video_post_duration_sec);
  if (Number.isFinite(max) && max > 0 && duration > max) return "This video exceeds your TikTok account's maximum length.";
  const options = state.creatorInfo.privacy_level_options || [];
  if (!post.privacy_level || !options.includes(post.privacy_level)) return "Choose an available privacy setting before posting.";
  if (state.tiktok.audited !== true && post.privacy_level !== "SELF_ONLY") return "Choose Only me until the TikTok app passes audit.";
  if (post.brand_content_toggle && post.privacy_level === "SELF_ONLY") return "Branded content cannot use Only me privacy.";
  for (const [selected, disabled] of [
    ["allow_comment", "comment_disabled"],
    ["allow_duet", "duet_disabled"],
    ["allow_stitch", "stitch_disabled"],
  ]) {
    if (post[selected] && state.creatorInfo[disabled]) return "A selected TikTok interaction is unavailable. Edit this draft first.";
  }
  return "";
}

function policyLink(text, url) {
  const link = make("a", "", text);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function reviewConsent(post, publish = false) {
  const label = make("label", "post-approval");
  const checkbox = make("input");
  checkbox.type = "checkbox";
  const copy = make("span");
  label.append(checkbox, copy);
  function setPublishing(value) {
    checkbox.checked = false;
    checkbox.dataset.tiktokAccountId = value ? state.creatorInfo?.account_open_id || '' : '';
    copy.replaceChildren();
    copy.append("I reviewed this video, caption, and settings" + (value ? " for " + creatorName() + ". " : ". This stays a private plan until I approve TikTok publishing."));
    if (value) {
      copy.append("By posting, you agree to TikTok's ");
      if (post.brand_content_toggle) {
        copy.append(policyLink("Branded Content Policy", "https://www.tiktok.com/legal/page/global/bc-policy/en"), " and ");
      }
      copy.append(policyLink("Music Usage Confirmation", "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"), ".");
    }
  }
  setPublishing(publish);
  return { label, checkbox, setPublishing };
}

function postRow(post) {
  const row = make("article", "post-row");
  row.setAttribute("aria-label", post.title || "Untitled draft");
  const top = make("div", "post-row-top");
  const titleWrap = make("div");
  titleWrap.append(make("h3", "", post.title || "Untitled draft"));
  const meta = make("div", "post-meta");
  if (post.scheduled_at) meta.append(make("span", "", "Planned " + formattedDate(post.scheduled_at)));
  if (post.published_at) meta.append(make("span", "", "Published " + formattedDate(post.published_at)));
  if (post.duration_seconds) meta.append(make("span", "", numberFormat.format(Number(post.duration_seconds)) + " sec"));
  titleWrap.append(meta);
  const badge = make("span", "status-badge " + String(post.status || "draft"), String(post.status || "draft").replaceAll("_", " "));
  top.append(titleWrap, badge);
  row.append(top);
  if (["queued", "scheduled"].includes(post.status) && !post.approved_at) {
    row.append(make("p", "field-help", "Planned privately. It will stay on hold until TikTok is connected and you approve publishing."));
  } else if (["queued", "scheduled"].includes(post.status) && post.approved_at) {
    row.append(make("p", "field-help", "Approved for automatic TikTok publishing when due. Move to drafts to cancel before processing starts."));
  } else if (post.status === "publishing") {
    row.append(make("p", "field-help", "TikTok is processing this post. It can take a few minutes to appear on your profile. Do not submit the same video again while its result is pending."));
  }
  if (post.caption) row.append(make("p", "post-caption", post.caption));

  const settings = make("div", "post-meta");
  settings.append(make("span", "", "Privacy: " + (privacyNames[post.privacy_level] || "Not selected")));
  settings.append(make("span", "", "Comments " + (post.allow_comment ? "on" : "off")));
  settings.append(make("span", "", "Duet " + (post.allow_duet ? "on" : "off")));
  settings.append(make("span", "", "Stitch " + (post.allow_stitch ? "on" : "off")));
  if (post.is_aigc) settings.append(make("span", "", "AI-generated"));
  if (post.brand_organic_toggle) settings.append(make("span", "", "Own brand"));
  if (post.brand_content_toggle) settings.append(make("span", "", "Branded content"));
  row.append(settings);
  if (post.brand_content_toggle || post.brand_organic_toggle) {
    row.append(make("p", "field-help", post.brand_content_toggle
      ? "This video will be labeled as Paid partnership."
      : "This video will be labeled as Promotional content."));
  }

  const previewUrl = safePreviewUrl(post.preview_url);
  if (previewUrl) {
    const video = make("video", "post-video");
    video.controls = true;
    video.preload = "none";
    video.playsInline = true;
    video.setAttribute("aria-label", "Video preview for " + (post.title || "untitled draft"));
    video.src = previewUrl;
    row.append(video);
    const link = make("a", "post-link", "Open video in a new tab");
    link.href = previewUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    row.append(link);
  }
  if (post.last_error) row.append(make("p", "post-error", post.last_error));

  if (post.status === "published") {
    const metrics = make("div", "post-metrics");
    for (const [label, key] of [
      ["Views", "view_count"], ["Likes", "like_count"],
      ["Comments", "comment_count"], ["Shares", "share_count"],
    ]) {
      const item = make("span");
      item.append(make("strong", "", metric(post[key])), " " + label);
      metrics.append(item);
    }
    row.append(metrics);
    if (post.analytics_synced_at) row.append(make("p", "field-help", "Metrics synced " + formattedDate(post.analytics_synced_at)));
    if (post.analytics_error) row.append(make("p", "post-error", post.analytics_error));
  }

  const id = String(post.id);
  if (post.status === "draft" || post.status === "failed") {
    const actions = make("div", "post-actions");
    actions.append(actionButton("Edit", "button-quiet", () => editPost(post)));
    const sendLabel = make("label", "post-approval publish-choice");
    const send = make("input");
    send.type = "checkbox";
    send.disabled = Boolean(publishingIssue(post));
    sendLabel.append(send, make("span", "", "Send to " + creatorName() + " now or automatically at the queue or scheduled time."));
    row.append(sendLabel);
    const approval = reviewConsent(post);
    const checkbox = approval.checkbox;
    row.append(approval.label);
    const issue = readinessIssue(post);
    if (issue) row.append(make("p", "field-help", issue));
    const sendIssue = publishingIssue(post);
    if (sendIssue && sendIssue !== issue) row.append(make("p", "field-help", sendIssue));
    const queue = actionButton("Add to private queue", "button-secondary", () => postAction(post, "queue", checkbox, undefined, undefined, send.checked));
    const publish = actionButton("Publish now", "button-primary", () => postAction(post, "publish", checkbox));
    publish.hidden = !state.tiktok.publishing_ready;
    queue.disabled = true;
    publish.disabled = true;
    actions.append(queue, publish);
    row.append(actions);
    const schedule = make("form", "schedule-form");
    const label = make("label", "", "Schedule for");
    const input = make("input");
    input.id = "schedule-" + id;
    label.htmlFor = input.id;
    input.type = "datetime-local";
    input.required = true;
    input.setAttribute("aria-describedby", "schedule-zone-" + id);
    const zone = make("span", "timezone", "EAT");
    zone.id = "schedule-zone-" + id;
    const scheduleButton = make("button", "button button-secondary button-small", "Save private schedule");
    scheduleButton.type = "submit";
    scheduleButton.disabled = true;
    schedule.append(label, input, zone, scheduleButton);
    schedule.addEventListener("submit", (event) => {
      event.preventDefault();
      postAction(post, "schedule", checkbox, input.value, scheduleButton, send.checked);
    });
    const updateActions = () => {
      const blocked = !checkbox.checked || Boolean(send.checked ? publishingIssue(post) : readinessIssue(post));
      queue.disabled = blocked;
      publish.disabled = blocked || !send.checked;
      scheduleButton.disabled = blocked;
      queue.textContent = send.checked ? "Queue for TikTok" : "Add to private queue";
      scheduleButton.textContent = send.checked ? "Schedule for TikTok" : "Save private schedule";
    };
    checkbox.addEventListener("change", updateActions);
    send.addEventListener("change", async () => {
      approval.setPublishing(send.checked);
      updateActions();
      checkbox.disabled = true;
      send.disabled = true;
      if (send.checked && !(await loadCreatorInfo())) send.checked = false;
      approval.setPublishing(send.checked);
      checkbox.disabled = false;
      send.disabled = Boolean(publishingIssue(post));
      updateActions();
    });
    row.append(schedule);
    row.append(actionButton("Delete draft", "button-danger button-small", () => deletePost(id)));
  } else if (post.status === "queued" || post.status === "scheduled") {
    const actions = make("div", "post-actions");
    if (!post.approved_at && state.tiktok.publishing_ready) {
      const approval = reviewConsent(post, true);
      const approve = actionButton("Approve TikTok publishing", "button-secondary button-small", () => postAction(post, "approve", approval.checkbox));
      const timePassed = !post.scheduled_at || new Date(post.scheduled_at).getTime() <= Date.now();
      approve.disabled = true;
      approval.checkbox.disabled = timePassed;
      approval.checkbox.addEventListener("change", () => { approve.disabled = timePassed || !approval.checkbox.checked || Boolean(publishingIssue(post)); });
      row.append(approval.label);
      const issue = publishingIssue(post);
      if (timePassed) row.append(make("p", "field-help", "The planned time has passed. Move to drafts and choose a future time before approving TikTok publishing."));
      else if (issue) row.append(make("p", "field-help", issue + " Move to drafts to edit."));
      actions.append(approve);
    }
    actions.append(actionButton("Move to drafts", "button-quiet button-small", () => postAction(post, "draft")));
    row.append(actions);
  } else if (post.status === "publishing") {
    row.append(actionButton("Check TikTok status", "button-secondary button-small", () => postAction(post, "status")));
  }
  return row;
}

function actionButton(label, style, action) {
  const button = make("button", "button " + style, label);
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await action();
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
  return button;
}

async function editPost(post) {
  if (state.tiktok.creator_info_ready) await loadCreatorInfo();
  state.editingId = post.id;
  state.editingPreviewUrl = safePreviewUrl(post.preview_url);
  state.editingDuration = post.duration_seconds || null;
  state.uploadedMedia = null;
  clearObjectPreview();
  renderMediaHelp();
  $("composerHeading").textContent = "Edit draft";
  $("saveDraftButton").textContent = "Save changes";
  $("cancelEdit").hidden = false;
  $("postTitle").value = post.title || "";
  $("postCaption").value = post.caption || "";
  $("videoFile").value = "";
  $("durationSeconds").value = post.duration_seconds || "";
  $("privacyLevel").value = post.privacy_level || "";
  $("allowComment").checked = Boolean(post.allow_comment) && !$("allowComment").disabled;
  $("allowDuet").checked = Boolean(post.allow_duet) && !$("allowDuet").disabled;
  $("allowStitch").checked = Boolean(post.allow_stitch) && !$("allowStitch").disabled;
  $("isAigc").checked = Boolean(post.is_aigc);
  $("commercialDisclosure").checked = Boolean(post.brand_organic_toggle || post.brand_content_toggle);
  $("brandOrganic").checked = Boolean(post.brand_organic_toggle);
  $("brandContent").checked = Boolean(post.brand_content_toggle);
  renderCommercialOptions();
  updatePreview();
  message("draftMessage");
  document.querySelector(".composer").scrollIntoView({ behavior: "smooth", block: "start" });
  $("postTitle").focus({ preventScroll: true });
}

function resetComposer() {
  state.editingId = null;
  state.editingPreviewUrl = "";
  state.editingDuration = null;
  state.uploadedMedia = null;
  clearObjectPreview();
  renderMediaHelp();
  $("draftForm").reset();
  $("composerHeading").textContent = "Create a draft";
  $("saveDraftButton").textContent = "Save draft";
  $("cancelEdit").hidden = true;
  $("durationSeconds").value = "";
  $("uploadState").hidden = true;
  $("uploadProgress").value = 0;
  $("uploadPercent").textContent = "0%";
  renderCommercialOptions();
  updatePreview();
  message("draftMessage");
}

function clearObjectPreview() {
  if (state.previewObjectUrl) URL.revokeObjectURL(state.previewObjectUrl);
  state.previewObjectUrl = "";
}

function updatePreview() {
  const url = state.previewObjectUrl || state.editingPreviewUrl;
  const video = $("draftPreview");
  if (url) {
    if (video.src !== url) video.src = url;
    video.hidden = false;
    $("previewEmpty").hidden = true;
    $("previewLink").href = url;
    $("previewLink").hidden = false;
  } else {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.hidden = true;
    $("previewEmpty").hidden = false;
    $("previewLink").hidden = true;
  }
}

function draftPayload() {
  const rawDuration = $("durationSeconds").value.trim();
  const duration = rawDuration ? Number(rawDuration) : null;
  if (rawDuration && (!Number.isInteger(duration) || duration <= 0 || duration > 36000)) {
    throw new Error("Enter a video length from 1 to 36,000 seconds.");
  }
  if ($("commercialDisclosure").checked && !$("brandOrganic").checked && !$("brandContent").checked) {
    throw new Error("Choose whether this post promotes your own brand, another brand, or both.");
  }
  return {
    title: $("postTitle").value.trim(),
    caption: $("postCaption").value.trim(),
    duration_seconds: duration,
    privacy_level: $("privacyLevel").value || null,
    allow_comment: $("allowComment").checked,
    allow_duet: $("allowDuet").checked,
    allow_stitch: $("allowStitch").checked,
    is_aigc: $("isAigc").checked,
    brand_organic_toggle: $("commercialDisclosure").checked && $("brandOrganic").checked,
    brand_content_toggle: $("commercialDisclosure").checked && $("brandContent").checked,
  };
}

function validateVideoFile(file) {
  if (!file) return;
  if (!/\.mp4$/i.test(file.name)) {
    throw new Error("Choose an MP4 video file.");
  }
  if (!file.size) throw new Error("The selected video is empty.");
  if (file.size > 500 * 1024 * 1024) throw new Error("Choose an MP4 video up to 500 MB.");
}

async function uploadMedia(file) {
  const intent = await api("/api/media/upload-intent", {
    method: "POST",
    body: { filename: file.name, size: file.size, content_type: "video/mp4" },
  });
  if (!intent.upload_url || !intent.upload_token || intent.method !== "PUT" || new URL(intent.upload_url).protocol !== "https:") {
    throw new Error("The video upload could not be started. Try again.");
  }
  await new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", intent.upload_url);
    for (const [name, value] of Object.entries(intent.headers || {})) request.setRequestHeader(name, value);
    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.min(100, Math.round(event.loaded / event.total * 100));
      $("uploadProgress").value = percent;
      $("uploadPercent").textContent = percent + "%";
    });
    request.addEventListener("load", () => {
      if (request.status < 200 || request.status >= 300) reject(new Error("The video could not be uploaded to storage. Try again."));
      else resolve();
    });
    request.addEventListener("error", () => reject(new Error("The video upload failed. Check your connection and try again.")));
    request.addEventListener("abort", () => reject(new Error("The video upload was cancelled.")));
    request.send(file);
  });
  return api("/api/media/complete", { method: "POST", body: { upload_token: intent.upload_token } });
}

function lockDraftForm() {
  const controls = [...$("draftForm").querySelectorAll("input, textarea, select, button"), $("cancelEdit"), $("logoutButton")];
  const prior = controls.map((control) => control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  $("draftForm").setAttribute("aria-busy", "true");
  return () => {
    controls.forEach((control, index) => { control.disabled = prior[index]; });
    $("videoFile").disabled = !state.mediaConfigured;
    $("draftForm").removeAttribute("aria-busy");
  };
}

function renderCommercialOptions() {
  const enabled = $("commercialDisclosure").checked;
  $("commercialOptions").hidden = !enabled;
  if (!enabled) {
    $("brandOrganic").checked = false;
    $("brandContent").checked = false;
  }
  updateCommercialLabel();
}

function updateCommercialLabel() {
  const branded = $("commercialDisclosure").checked && $("brandContent").checked;
  const organic = $("commercialDisclosure").checked && $("brandOrganic").checked;
  $("commercialLabel").textContent = branded
    ? "Your video will be labeled as Paid partnership. Branded content cannot use Only me privacy."
    : organic ? "Your video will be labeled as Promotional content."
      : "Choose your own brand, another brand, or both before publishing.";
  for (const option of $("privacyLevel").options) {
    if (option.value === "SELF_ONLY") option.disabled = branded;
  }
  if (branded && $("privacyLevel").value === "SELF_ONLY") $("privacyLevel").value = "";
}

async function postAction(post, action, approval, localTime, button, publishToTikTok = false) {
  try {
    const id = encodeURIComponent(String(post.id));
    const body = {};
    if (["queue", "schedule", "publish", "approve"].includes(action)) {
      if (!approval || !approval.checked) throw new Error("Review and approve this post first.");
      const publishing = publishToTikTok || ["publish", "approve"].includes(action);
      const reviewedAccount = approval.dataset.tiktokAccountId;
      if (publishing && !(await loadCreatorInfo())) throw new Error("TikTok posting settings could not be refreshed. Try again before approving.");
      if (publishing && (!reviewedAccount || reviewedAccount !== state.creatorInfo?.account_open_id)) {
        renderPosts();
        throw new Error('The TikTok account changed. Review this post again for the connected account.');
      }
      const issue = publishing ? publishingIssue(post) : readinessIssue(post);
      if (issue) throw new Error(issue);
      body.approved = true;
      if (publishing) body.account_open_id = reviewedAccount;
      if (["queue", "schedule"].includes(action)) body.publish_to_tiktok = publishToTikTok;
    }
    if (action === "schedule") {
      if (!localTime) throw new Error("Choose a date and time in East Africa Time.");
      const when = new Date(localTime + ":00+03:00");
      if (Number.isNaN(when.valueOf()) || when.getTime() <= Date.now()) throw new Error("Choose a future date and time.");
      body.scheduled_at = when.toISOString();
    }
    if (button) button.disabled = true;
    const result = await api("/api/posts/" + id + "/" + action, { method: "POST", body });
    await loadPosts();
    if (action === "publish" && result.status === "failed") {
      message("workspaceMessage", result.last_error || "TikTok could not publish this post. Review the draft and try again.", "error");
    } else {
      const notices = {
        draft: "Post moved to drafts. Any automatic publishing approval was cancelled.",
        publish: "Post approved. Publishing will start shortly; TikTok may take a few minutes to process it.",
        approve: "This planned post is approved for automatic TikTok publishing when due.",
        status: "TikTok status refreshed.",
      };
      message("workspaceMessage", notices[action] || (publishToTikTok
        ? "Post approved for automatic TikTok publishing at its planned time."
        : "Private plan saved. It will stay on hold until you approve TikTok publishing."), "success");
    }
  } catch (error) {
    message("workspaceMessage", error.message, "error");
  } finally {
    if (button && button.isConnected) button.disabled = false;
  }
}

async function deletePost(id) {
  if (!window.confirm("Delete this draft? This cannot be undone.")) return;
  try {
    await api("/api/posts/" + encodeURIComponent(id), { method: "DELETE" });
    await loadPosts();
    message("workspaceMessage", "Draft deleted.", "success");
  } catch (error) {
    message("workspaceMessage", error.message, "error");
  }
}

function renderAnalytics() {
  const host = $("analyticsContent");
  host.replaceChildren();
  const data = state.analytics;
  $("refreshAnalytics").disabled = !data?.available;
  if (state.analyticsError) host.append(make("p", "analytics-empty", "Metrics could not be loaded: " + state.analyticsError + " Use Refresh connection, then try syncing again."));
  if (!data) {
    if (!state.analyticsError) host.append(make("p", "analytics-empty", "Loading performance…"));
    return;
  }
  if (!data.available && data.reason) host.append(make("p", "analytics-empty", data.reason));
  const posts = Array.isArray(data.posts) ? data.posts : [];
  const summary = data.summary || {};
  if (!posts.length) {
    host.append(make("p", "analytics-empty", "Publish a video with Postmanager to start tracking its performance. TikTok returns these counts for public posts; private posts may have no data."));
    return;
  }
  host.append(make("p", "analytics-source", "Metrics available for " + (summary.posts_with_metrics || 0) + " of " + (summary.published_posts || posts.length) + " published posts." +
    (summary.last_synced_at ? " Last sync " + formattedDate(summary.last_synced_at) + "." : " No metrics have been returned yet.")));
  const strip = make("div", "analytics-strip");
  for (const [label, key] of [
    ["Views", "view_count"], ["Likes", "like_count"],
    ["Comments", "comment_count"], ["Shares", "share_count"],
  ]) {
    const cell = make("div", "analytics-cell");
    cell.append(make("span", "", label), make("strong", "", metric(summary.totals?.[key])));
    strip.append(cell);
  }
  host.append(strip);
  host.append(make("p", "field-help analytics-note", "Totals cover posts with returned data. A dash means unavailable, not zero. Existing counts stay visible when TikTok cannot return a new reading."));
  const listing = make("div", "analytics-posts");
  for (const post of posts) {
    const section = make("article", "analytics-post");
    section.append(make("h3", "", post.title || "Untitled post"));
    const counts = make("div", "post-metrics");
    for (const [label, key] of [["Views", "view_count"], ["Likes", "like_count"], ["Comments", "comment_count"], ["Shares", "share_count"]]) {
      const item = make("span");
      item.append(make("strong", "", metric(post[key])), " " + label);
      counts.append(item);
    }
    section.append(counts);
    section.append(make("p", "field-help analytics-note", post.analytics_synced_at
      ? "Last successful sync " + formattedDate(post.analytics_synced_at) + (post.stale ? ". These counts may be out of date." : ".")
      : "No metrics returned yet. Private posts and posts still processing may have no available counts."));
    if (post.analytics_error) section.append(make("p", "post-error", post.analytics_error));
    if (Array.isArray(post.snapshots) && post.snapshots.length) {
      const history = make("details", "metric-history");
      history.append(make("summary", "", "Metric history (" + post.snapshots.length + " readings)"));
      const scroll = make("div", "table-scroll");
      scroll.tabIndex = 0;
      scroll.setAttribute("role", "region");
      scroll.setAttribute("aria-label", "Metric history for " + (post.title || "untitled post"));
      const table = make("table", "metrics-table");
      const caption = make("caption", "", "Recorded TikTok metrics for " + (post.title || "untitled post"));
      const thead = make("thead");
      const headings = make("tr");
      for (const label of ["Recorded (EAT)", "Views", "Likes", "Comments", "Shares"]) {
        const heading = make("th", "", label);
        heading.scope = "col";
        headings.append(heading);
      }
      thead.append(headings);
      const tbody = make("tbody");
      for (const snapshot of post.snapshots) {
        const tr = make("tr");
        tr.append(make("td", "", formattedDate(snapshot.captured_at)));
        for (const key of ["view_count", "like_count", "comment_count", "share_count"]) tr.append(make("td", "", metric(snapshot[key])));
        tbody.append(tr);
      }
      table.append(caption, thead, tbody);
      scroll.append(table);
      history.append(scroll);
      section.append(history);
    }
    listing.append(section);
  }
  host.append(listing);
  if (data.truncated) host.append(make("p", "field-help analytics-note", "Showing the 100 most recent published posts."));
}

$("phoneForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  message("authMessage");
  try {
    state.phone = $("phone").value.trim();
    const result = await api("/api/auth/request-otp", { method: "POST", body: { phone: state.phone } });
    $("phoneDisplay").textContent = state.phone;
    $("phoneForm").hidden = true;
    $("codeForm").hidden = false;
    $("code").focus();
    message("authMessage", result.resend_in ? "Code sent. You can request another in " + result.resend_in + " seconds." : "Code sent.", "success");
  } catch (error) {
    message("authMessage", error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("codeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  message("authMessage");
  try {
    const user = await api("/api/auth/verify-otp", { method: "POST", body: { phone: state.phone, code: $("code").value.trim() } });
    $("accountPhone").textContent = user.phone || state.phone;
    $("code").value = "";
    show("app");
    await Promise.allSettled([loadTikTok(), loadMediaStatus(), loadSettings(), loadPosts(), loadAnalytics(), loadTikTokVideos(true)]);
  } catch (error) {
    message("authMessage", error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("changePhone").addEventListener("click", () => {
  $("codeForm").hidden = true;
  $("phoneForm").hidden = false;
  $("code").value = "";
  message("authMessage");
  $("phone").focus();
});

$("logoutButton").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", body: {} });
    state.posts = null;
    state.tiktok = { connected: false, configured: true };
    state.creatorInfo = null;
    state.analytics = null;
    state.analyticsError = "";
    state.accountVideos = null;
    state.accountVideoSummary = null;
    state.accountVideoAvailable = false;
    state.accountVideoError = "";
    state.accountVideoInitialized = false;
    state.accountVideoAutoStarted = false;
    showWorkspacePage("planner");
    clearTimeout(plannerPoll);
    state.mediaConfigured = false;
    state.mediaStatusError = "";
    resetComposer();
    $("videoFile").disabled = true;
    $("mediaStatus").textContent = "Checking video storage…";
    $("codeForm").hidden = true;
    $("phoneForm").hidden = false;
    show("auth");
  } catch (error) {
    message("workspaceMessage", error.message, "error");
  }
});

$("addQueueTime").addEventListener("click", () => addQueueTime());
$("queueForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  message("queueMessage");
  const values = [...$("queueTimes").querySelectorAll('input[type="time"]')].map((input) => input.value).filter(Boolean);
  const times = [...new Set(values)].sort();
  if (!times.length) {
    message("queueMessage", "Add at least one posting time.", "error");
    button.disabled = false;
    return;
  }
  try {
    const result = await api("/api/settings", { method: "PUT", body: { queue_times: times } });
    state.settings = result.settings || result;
    renderQueueTimes();
    message("queueMessage", "Queue times saved.", "success");
  } catch (error) {
    message("queueMessage", error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("videoFile").addEventListener("change", () => {
  const file = $("videoFile").files[0];
  try {
    validateVideoFile(file);
    state.uploadedMedia = null;
    clearObjectPreview();
    if (file) {
      state.previewObjectUrl = URL.createObjectURL(file);
      $("durationSeconds").value = "";
      message("draftMessage");
    } else {
      $("durationSeconds").value = state.editingDuration || "";
    }
    updatePreview();
  } catch (error) {
    $("videoFile").value = "";
    state.uploadedMedia = null;
    clearObjectPreview();
    $("durationSeconds").value = state.editingDuration || "";
    updatePreview();
    message("draftMessage", error.message, "error");
  }
});
$("commercialDisclosure").addEventListener("change", renderCommercialOptions);
$("brandOrganic").addEventListener("change", updateCommercialLabel);
$("brandContent").addEventListener("change", updateCommercialLabel);
$("draftPreview").addEventListener("loadedmetadata", () => {
  const seconds = Math.ceil($("draftPreview").duration);
  if (!$("durationSeconds").value && Number.isFinite(seconds) && seconds > 0) $("durationSeconds").value = String(seconds);
});
$("cancelEdit").addEventListener("click", resetComposer);
$("draftForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  message("draftMessage");
  let unlock = () => {};
  try {
    const payload = draftPayload();
    if (!payload.title) throw new Error("Give this draft a working title.");
    const file = $("videoFile").files[0];
    validateVideoFile(file);
    if (file && !state.mediaConfigured && (!state.uploadedMedia || state.uploadedMedia.file !== file)) {
      throw new Error("Video uploads are unavailable right now.");
    }
    const path = state.editingId === null ? "/api/posts" : "/api/posts/" + encodeURIComponent(String(state.editingId));
    const method = state.editingId === null ? "POST" : "PATCH";
    unlock = lockDraftForm();
    if (file) {
      if (!state.uploadedMedia || state.uploadedMedia.file !== file) {
        $("uploadProgress").value = 0;
        $("uploadPercent").textContent = "0%";
        $("uploadState").hidden = false;
        const media = await uploadMedia(file);
        state.uploadedMedia = { file, media };
      }
      payload.media_asset_id = state.uploadedMedia.media.id;
      if (!payload.duration_seconds && $("durationSeconds").value) {
        payload.duration_seconds = Number($("durationSeconds").value);
      }
      $("uploadState").hidden = true;
      message("draftMessage", "Video uploaded. Saving draft…");
    }
    await api(path, { method, body: payload });
    resetComposer();
    await loadPosts();
    message("workspaceMessage", "Draft saved.", "success");
  } catch (error) {
    message("draftMessage", error.message, "error");
  } finally {
    $("uploadState").hidden = true;
    unlock();
    button.disabled = false;
  }
});

$("refreshPlanner").addEventListener("click", async () => {
  $("refreshPlanner").disabled = true;
  try {
    await Promise.allSettled([loadTikTok(), loadMediaStatus(), loadPosts(), loadAnalytics()]);
  } finally { $("refreshPlanner").disabled = false; }
});
$("refreshAnalytics").addEventListener("click", () => loadAnalytics(true));
$("showPlannerPage").addEventListener("click", () => showWorkspacePage("planner"));
$("showAccountPage").addEventListener("click", () => showWorkspacePage("account"));
$("syncAccountVideos").addEventListener("click", () => syncTikTokAccountVideos(false));
$("loadOlderVideos").addEventListener("click", () => syncTikTokAccountVideos(true));
$("refreshAccountMetrics").addEventListener("click", refreshTikTokAccountMetrics);
$("refreshTikTok").addEventListener("click", async () => {
  $("refreshTikTok").disabled = true;
  try {
    await loadTikTok();
    await loadTikTokVideos(true);
    await loadAnalytics();
  } finally { $("refreshTikTok").disabled = false; }
});
$("plannerTabs").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter;
  for (const tab of $("plannerTabs").querySelectorAll(".tab")) {
    const active = tab === button;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  }
  renderPosts();
});

start();
