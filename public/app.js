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
  settings: { timezone: "Africa/Dar_es_Salaam", queue_times: [] },
};

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

async function start() {
  try {
    const user = await api("/api/me");
    $("accountPhone").textContent = user.phone || "";
    show("app");
    await Promise.allSettled([loadTikTok(), loadMediaStatus(), loadSettings(), loadPosts()]);
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
      status.textContent = "TikTok connection is unavailable right now.";
      connect.hidden = true;
      state.creatorInfo = null;
    } else if (state.tiktok.connected) {
      const name = state.tiktok.username || state.tiktok.nickname;
      status.textContent = name ? "Connected: " + name : "TikTok connected.";
      if (state.tiktok.publishing_ready !== true) {
        status.textContent += " Publishing is on hold while video delivery is being configured. You can still prepare your queue.";
      }
      connect.hidden = true;
      await loadCreatorInfo();
    } else {
      status.textContent = "Connect TikTok to publish posts and see their performance.";
      connect.hidden = false;
      state.creatorInfo = null;
    }
    renderPosts();
  } catch (error) {
    $("tiktokStatus").textContent = "TikTok status is unavailable. " + error.message;
    $("connectTikTok").hidden = false;
    state.creatorInfo = null;
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
  } catch (error) {
    state.creatorInfo = null;
    $("tiktokStatus").textContent += " Posting settings are unavailable: " + error.message;
    applyCreatorInfo();
  }
}

function applyCreatorInfo() {
  const select = $("privacyLevel");
  const selected = select.value;
  const options = state.creatorInfo && Array.isArray(state.creatorInfo.privacy_level_options)
    ? state.creatorInfo.privacy_level_options : [];
  select.replaceChildren();
  const placeholder = make("option", "", state.tiktok.connected ? "Choose who can watch" : "Connect TikTok to choose");
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
  $("durationHelp").textContent = Number.isFinite(max) && max > 0
    ? "Your TikTok account allows videos up to " + numberFormat.format(max) + " seconds. We will fill this from the preview when available."
    : "We will fill this from the video when available. You can enter it yourself.";
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
  try {
    const result = await api("/api/posts");
    state.posts = Array.isArray(result.posts) ? result.posts : [];
    state.postsError = "";
    message("workspaceMessage");
    renderPosts();
    renderAnalytics();
  } catch (error) {
    state.posts = null;
    state.postsError = error.message;
    message("workspaceMessage", error.message, "error");
    renderPosts();
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
      ? ["Your planner starts here", "Save your first draft above. You can queue it once its video and TikTok settings are ready."]
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

function readinessIssue(post) {
  if (!state.tiktok.connected) return "Connect TikTok before posting.";
  if (!state.creatorInfo) return "TikTok posting settings are unavailable. Refresh the page and try again.";
  if (!post.media_asset_id) return "Upload an MP4 video before posting.";
  if (!safePreviewUrl(post.preview_url)) return "Video preview is unavailable. Refresh and try again.";
  const duration = Number(post.duration_seconds);
  if (!Number.isFinite(duration) || duration <= 0) return "Add the video length before posting.";
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
  }

  const id = String(post.id);
  if (post.status === "draft" || post.status === "failed") {
    const actions = make("div", "post-actions");
    actions.append(actionButton("Edit", "button-quiet", () => editPost(post)));
    const approval = make("label", "post-approval");
    const checkbox = make("input");
    checkbox.type = "checkbox";
    const declaration = post.brand_content_toggle
      ? "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation."
      : "By posting, you agree to TikTok's Music Usage Confirmation.";
    approval.append(checkbox, make("span", "", "I reviewed the video, caption, and TikTok settings for " + (post.title || "this draft") + " and approve this post. " + declaration));
    row.append(approval);
    const issue = readinessIssue(post);
    if (issue) row.append(make("p", "field-help", issue));
    if (state.tiktok.connected && state.tiktok.publishing_ready !== true) {
      row.append(make("p", "field-help", "Publish now is unavailable. Queued and scheduled posts will be held until publishing is enabled."));
    }
    const queue = actionButton("Add to queue", "button-secondary", () => postAction(post, "queue", checkbox));
    const publish = actionButton("Publish now", "button-primary", () => postAction(post, "publish", checkbox));
    queue.disabled = true;
    publish.disabled = true;
    checkbox.addEventListener("change", () => {
      queue.disabled = !checkbox.checked || Boolean(readinessIssue(post));
      publish.disabled = !checkbox.checked || Boolean(readinessIssue(post)) || state.tiktok.publishing_ready !== true;
      scheduleButton.disabled = !checkbox.checked || Boolean(readinessIssue(post));
    });
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
    const scheduleButton = make("button", "button button-secondary button-small", "Schedule");
    scheduleButton.type = "submit";
    scheduleButton.disabled = true;
    schedule.append(label, input, zone, scheduleButton);
    schedule.addEventListener("submit", (event) => {
      event.preventDefault();
      postAction(post, "schedule", checkbox, input.value, scheduleButton);
    });
    row.append(schedule);
    row.append(actionButton("Delete draft", "button-danger button-small", () => deletePost(id)));
  } else if (post.status === "queued" || post.status === "scheduled") {
    const actions = make("div", "post-actions");
    actions.append(actionButton("Move to drafts", "button-quiet button-small", () => postAction(post, "draft")));
    row.append(actions);
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

function editPost(post) {
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

function uploadMedia(file) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/media");
    request.responseType = "json";
    request.withCredentials = true;
    request.setRequestHeader("Accept", "application/json");
    request.setRequestHeader("Content-Type", "video/mp4");
    request.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.min(100, Math.round(event.loaded / event.total * 100));
      $("uploadProgress").value = percent;
      $("uploadPercent").textContent = percent + "%";
    });
    request.addEventListener("load", () => {
      const result = request.response || {};
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(result.error || result.message || "The video could not be uploaded."));
      } else if (!result.id || !safePreviewUrl(result.preview_url)) {
        reject(new Error("The video upload returned an incomplete result. Try again."));
      } else {
        resolve(result);
      }
    });
    request.addEventListener("error", () => reject(new Error("The video upload failed. Check your connection and try again.")));
    request.addEventListener("abort", () => reject(new Error("The video upload was cancelled.")));
    request.send(file);
  });
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
}

async function postAction(post, action, approval, localTime, button) {
  try {
    const id = encodeURIComponent(String(post.id));
    const body = {};
    if (["queue", "schedule", "publish"].includes(action)) {
      if (!approval || !approval.checked) throw new Error("Review and approve this post first.");
      if (!state.tiktok.connected) throw new Error("Connect TikTok before posting.");
      if (action === "publish" && state.tiktok.publishing_ready !== true) {
        throw new Error("Publishing is on hold while video delivery is being configured.");
      }
      await loadCreatorInfo();
      const issue = readinessIssue(post);
      if (issue) throw new Error(issue);
      body.approved = true;
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
      message("workspaceMessage", action === "draft" ? "Post moved to drafts." : action === "publish" ? "Publish request sent. Check this post for its latest status." : "Post added to your plan.", "success");
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
  if (!state.posts) {
    host.append(make("p", "analytics-empty", state.postsError
      ? "Performance is unavailable until your posts load."
      : "Loading performance…"));
    return;
  }
  const published = state.posts.filter((post) => post.status === "published");
  const available = published.filter((post) => ["view_count", "like_count", "comment_count", "share_count"].some((key) => post[key] !== null && post[key] !== undefined));
  if (!available.length) {
    host.append(make("p", "analytics-empty", "Views and engagement will appear after TikTok returns data for a public post."));
    return;
  }
  host.append(make("p", "analytics-source", "TikTok data for " + available.length + " of " + published.length + " published " + (published.length === 1 ? "post" : "posts") + "."));
  const strip = make("div", "analytics-strip");
  for (const [label, key] of [
    ["Views", "view_count"], ["Likes", "like_count"],
    ["Comments", "comment_count"], ["Shares", "share_count"],
  ]) {
    const cell = make("div", "analytics-cell");
    const complete = available.every((post) => post[key] !== null && post[key] !== undefined);
    const total = complete ? available.reduce((sum, post) => sum + Number(post[key]), 0) : null;
    cell.append(make("span", "", label), make("strong", "", complete ? numberFormat.format(total) : "—"));
    strip.append(cell);
  }
  host.append(strip);
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
    await Promise.allSettled([loadTikTok(), loadMediaStatus(), loadSettings(), loadPosts()]);
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
  await Promise.allSettled([loadTikTok(), loadMediaStatus(), loadPosts()]);
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
