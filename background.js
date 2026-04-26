console.log("Extension Active");

// ─── Gemini + history-based learning ──────────────────────────────────────
const GEMINI_MODEL_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";
const GEMINI_TIMEOUT_MS = 10_000;
const LEARNING_CAPTURE_LIMIT = 60;
const LEARNING_BUCKET_LIMIT = 50;

const HISTORY_NOISE_PATTERNS = [
  /^chrome:\/\//i,
  /^chrome-extension:\/\//i,
  /^about:/i,
  /^edge:\/\//i,
  /(^|\.)google\.com\/search/i,
  /^https?:\/\/mail\.google\.com/i,
  /^https?:\/\/calendar\.google\.com/i,
  /^https?:\/\/(www\.)?google\.com\/?(\?.*)?$/i,
  /^https?:\/\/accounts\.google\.com/i,
];

function isNoiseUrl(url) {
  if (!url) return true;
  return HISTORY_NOISE_PATTERNS.some((re) => re.test(url));
}

const LEARNING_NOISE_PATTERNS = [
  /(^|\.)google\.com\/search/i,
  /^https?:\/\/mail\.google\.com/i,
  /(^|\.)doubleclick\.net/i,
  /(^|\.)googlesyndication\.com/i,
  /(^|\.)googleadservices\.com/i,
  /(^|\.)adservice\.google\./i,
  /(^|\.)adsystem\.com/i,
  /(^|\.)taboola\.com/i,
  /(^|\.)outbrain\.com/i,
];

function isLearningNoiseUrl(url) {
  if (!url) return true;
  if (isNoiseUrl(url)) return true;
  return LEARNING_NOISE_PATTERNS.some((re) => re.test(url));
}

function domainFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

function sanitizeLearningUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(normalizeUrl(url));
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    parsed.search = "";
    parsed.hash = "";
    const sanitized = parsed.toString();
    if (isLearningNoiseUrl(sanitized)) return null;
    return sanitized;
  } catch {
    return null;
  }
}

function trimKeywordBucket(bucket, maxUrls = LEARNING_BUCKET_LIMIT) {
  return Object.fromEntries(
    Object.entries(bucket || {})
      .filter(([, count]) => Number.isFinite(count) && count > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, maxUrls)
  );
}

async function getGeminiApiKey() {
  try {
    const result = await chrome.storage.local.get("geminiApiKey");
    const key = typeof result.geminiApiKey === "string" ? result.geminiApiKey.trim() : "";
    return key || null;
  } catch (err) {
    console.warn("[categorizeEvent] failed to read geminiApiKey:", err.message);
    return null;
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function categorizeEvent(eventTitle) {
  if (!eventTitle) {
    console.log("[categorizeEvent] empty title, skipping");
    return null;
  }
  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    console.log("[categorizeEvent] no geminiApiKey in storage, falling back to keyword matching");
    return null;
  }
  const prompt =
    `Categorize this calendar event title into a single, lowercase, ` +
    `one-word category (e.g., finance, design, engineering, sync, personal): ` +
    `${eventTitle}`;

  try {
    const res = await fetchWithTimeout(
      `${GEMINI_MODEL_URL}?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 8 },
        }),
      },
      GEMINI_TIMEOUT_MS
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(`[categorizeEvent] HTTP ${res.status}:`, errText);
      return null;
    }
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const category = raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)[0];
    console.log(`[categorizeEvent] "${eventTitle}" → "${category}"`);
    return category || null;
  } catch (err) {
    console.warn("[categorizeEvent] failed:", err.message);
    return null;
  }
}

async function learnFromHistory(category, meetingStartTime, meetingEndTime) {
  if (!category) {
    console.log("[learnFromHistory] no category, skipping");
    return [];
  }
  if (
    typeof meetingStartTime !== "number" ||
    typeof meetingEndTime !== "number" ||
    meetingEndTime <= meetingStartTime
  ) {
    console.warn("[learnFromHistory] invalid time window:", {
      meetingStartTime,
      meetingEndTime,
    });
    return [];
  }

  const items = await new Promise((resolve) => {
    chrome.history.search(
      {
        text: "",
        startTime: meetingStartTime,
        endTime: meetingEndTime,
        maxResults: 1000,
      },
      (results) => resolve(results || [])
    );
  });

  console.log(
    `[learnFromHistory] category="${category}" window=[${new Date(
      meetingStartTime
    ).toISOString()}..${new Date(meetingEndTime).toISOString()}] items=${items.length}`
  );

  const counts = new Map();
  for (const item of items) {
    const sanitizedUrl = sanitizeLearningUrl(item.url);
    if (!sanitizedUrl) continue;
    if (
      typeof item.lastVisitTime === "number" &&
      (item.lastVisitTime < meetingStartTime || item.lastVisitTime > meetingEndTime)
    ) {
      continue;
    }
    const domain = domainFromUrl(sanitizedUrl);
    if (!domain) continue;
    counts.set(domain, (counts.get(domain) || 0) + (item.visitCount || 1));
  }

  const top3 = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([domain]) => domain);

  console.log(`[learnFromHistory] top domains for "${category}":`, top3);

  try {
    const stored = (await chrome.storage.local.get(category))[category] || [];
    const merged = [...new Set([...top3, ...stored])].slice(0, 3);
    await chrome.storage.local.set({ [category]: merged });
    console.log(`[learnFromHistory] saved {${category}: ${JSON.stringify(merged)}}`);
    return merged;
  } catch (err) {
    console.warn("[learnFromHistory] storage write failed:", err.message);
    return top3;
  }
}

// Expose for manual testing in the service-worker DevTools console.
self.categorizeEvent = categorizeEvent;
self.learnFromHistory = learnFromHistory;


const ICON_STATES = ["grey", "blue", "green"];
const ICON_SIZES = [16, 32, 48, 128];

function iconPaths(state) {
  const paths = {};
  for (const size of ICON_SIZES) {
    paths[size] = `icons/icon-${state}-${size}.png`;
  }
  return paths;
}

function setIconColor(state) {
  if (!ICON_STATES.includes(state)) {
    throw new Error(`Unknown icon state: ${state}. Expected one of ${ICON_STATES.join(", ")}.`);
  }
  return chrome.action.setIcon({ path: iconPaths(state) });
}

// Expose on the service worker global so it can be invoked from DevTools
// for manual verification (e.g. `setIconColor("blue")`).
self.setIconColor = setIconColor;

chrome.runtime.onInstalled.addListener(() => {
  setIconColor("grey");
});

const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const ZOOM_URL_RE = /https:\/\/[\w.-]*zoom\.us\/[^\s<>"')]+/i;
const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

function getAuthToken({ interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "No auth token returned"));
        return;
      }
      resolve(token);
    });
  });
}

async function fetchUpcomingEvents({ interactive = false } = {}) {
  const token = await getAuthToken({ interactive });
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: in24h.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });
  const res = await fetch(`${CALENDAR_API}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
    throw new Error("Auth token rejected (401). Removed from cache — try again.");
  }
  if (!res.ok) {
    throw new Error(`Calendar API error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.items || [];
}

function meetingLinkFor(event) {
  if (event.hangoutLink) return event.hangoutLink;
  const match = event.description?.match(ZOOM_URL_RE);
  return match ? match[0] : null;
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "www.google.com" && parsed.pathname === "/url") {
      const target = parsed.searchParams.get("q");
      if (target) {
        return normalizeUrl(target);
      }
    }
    parsed.hash = "";
    if ((parsed.protocol === "http:" && parsed.port === "80") ||
        (parsed.protocol === "https:" && parsed.port === "443")) {
      parsed.port = "";
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function extractUrlsFromText(text) {
  return (text?.match(URL_RE) || []).map(normalizeUrl);
}

function extractUrlsFromEvent(event) {
  const urls = new Set();
  const addUrls = (items) => {
    for (const url of items) {
      urls.add(url);
    }
  };

  addUrls(extractUrlsFromText(event.location));
  addUrls(extractUrlsFromText(event.description));

  if (event.hangoutLink) {
    urls.add(normalizeUrl(event.hangoutLink));
  }

  for (const attachment of event.attachments || []) {
    if (attachment.fileUrl) {
      urls.add(normalizeUrl(attachment.fileUrl));
    }
  }

  return [...urls];
}

function pickCurrentOrUpcoming(events) {
  const now = Date.now();
  for (const ev of events) {
    const end = new Date(ev.end?.dateTime || ev.end?.date || 0).getTime();
    if (end > now) return ev;
  }
  return null;
}

async function logCurrentOrUpcomingEvent() {
  const events = await fetchUpcomingEvents();
  const ev = pickCurrentOrUpcoming(events);
  if (!ev) {
    console.log("Tempo: no current or upcoming events in the next 24h.");
    return null;
  }
  const link = meetingLinkFor(ev) || "(no meeting link)";
  console.log(`Tempo event: "${ev.summary || "(untitled)"}" — ${link}`);
  return ev;
}

self.getAuthToken = getAuthToken;
self.fetchUpcomingEvents = fetchUpcomingEvents;
self.logCurrentOrUpcomingEvent = logCurrentOrUpcomingEvent;

const LEARN_ALARM = "tempo-learn";
const LEARN_PERIOD_MIN = 5;
const STORAGE_KEY = "keywords";

const STOP_WORDS = new Set([
  "a", "an", "and", "the", "or", "of", "for", "to", "with", "in", "on", "at",
  "by", "from", "is", "are", "be", "as", "vs", "via",
  "meeting", "meet", "sync", "syncs", "call", "calls", "chat", "standup",
  "stand-up", "1on1", "1-on-1", "1:1", "weekly", "daily", "monthly", "review",
  "check-in", "checkin", "catchup", "catch-up", "discussion", "discuss",
]);

function extractKeywords(title) {
  if (!title) return [];
  return [...new Set(
    title.toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
  )];
}

function pickActiveEvent(events) {
  const now = Date.now();
  for (const ev of events) {
    const start = new Date(ev.start?.dateTime || ev.start?.date || 0).getTime();
    const end = new Date(ev.end?.dateTime || ev.end?.date || 0).getTime();
    if (start <= now && now < end) return ev;
  }
  return null;
}

async function getActiveWindowTabUrls() {
  const win = await chrome.windows.getLastFocused({ populate: true });
  return (win.tabs || [])
    .map((t) => t.url)
    .filter((u) => u && /^https?:\/\//i.test(u));
}

async function recordTabsForActiveEvent() {
  let events;
  try {
    events = await fetchUpcomingEvents();
  } catch (err) {
    console.warn("Tempo learn: calendar fetch failed:", err.message);
    return;
  }
  const ev = pickActiveEvent(events);
  if (!ev) return;

  const keywords = extractKeywords(ev.summary);
  if (keywords.length === 0) return;

  const sanitizedUrls = [...new Set(
    (await getActiveWindowTabUrls())
      .map(sanitizeLearningUrl)
      .filter(Boolean)
  )].slice(0, LEARNING_CAPTURE_LIMIT);
  if (sanitizedUrls.length === 0) return;

  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
  for (const kw of keywords) {
    const bucket = stored[kw] || {};
    for (const url of sanitizedUrls) {
      bucket[url] = (bucket[url] || 0) + 1;
    }
    stored[kw] = trimKeywordBucket(bucket);
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: stored });

  console.log(
    `Tempo learn: "${ev.summary}" → keywords [${keywords.join(", ")}], recorded ${sanitizedUrls.length} tab(s).`
  );
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LEARN_ALARM) recordTabsForActiveEvent();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(LEARN_ALARM, { periodInMinutes: LEARN_PERIOD_MIN });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(LEARN_ALARM, { periodInMinutes: LEARN_PERIOD_MIN });
});

self.extractKeywords = extractKeywords;
self.recordTabsForActiveEvent = recordTabsForActiveEvent;

const NOTIFY_ALARM = "tempo-notify";
const NOTIFY_PERIOD_MIN = 1;
const SNOOZE_ALARM_PREFIX = "tempo-snooze:";
const SNOOZE_DELAY_MIN = 5;
const NOTIF_ID_PREFIX = "tempo-notif:";
const NOTIFY_LOOKAHEAD_MS = 10 * 60 * 1000;
const LAUNCH_FREQ_MIN = 2;
const LAUNCH_MAX_TABS = 8;
const LAUNCH_DEBOUNCE_MS = 30_000;
const PENDING_KEY = "pendingLaunches";
const NOTIFIED_KEY = "notifiedEventIds";
const LAUNCHED_KEY = "launchedEvent";
const POPUP_STATUS_KEY = "popupStatus";
const recentLaunches = new Map();

function shouldSkipDebouncedLaunch(eventId) {
  if (!eventId) return true;
  const now = Date.now();
  for (const [id, ts] of recentLaunches.entries()) {
    if (now - ts > LAUNCH_DEBOUNCE_MS) recentLaunches.delete(id);
  }
  const previous = recentLaunches.get(eventId);
  if (previous && now - previous < LAUNCH_DEBOUNCE_MS) return true;
  recentLaunches.set(eventId, now);
  return false;
}

function pickEventStartingSoon(events, withinMs) {
  const now = Date.now();
  for (const ev of events) {
    const start = new Date(ev.start?.dateTime || ev.start?.date || 0).getTime();
    if (start > now && start - now <= withinMs) return ev;
  }
  return null;
}

function pickLaunchableActiveEvent(events) {
  const now = Date.now();
  for (const ev of events) {
    const start = new Date(ev.start?.dateTime || ev.start?.date || 0).getTime();
    const end = eventEndMs(ev);
    if (start <= now && now < end) return ev;
  }
  return null;
}

function rankUrlsForKeywords(keywords, keywordMap) {
  const totals = new Map();
  for (const kw of keywords) {
    const bucket = keywordMap[kw];
    if (!bucket) continue;
    for (const [url, count] of Object.entries(bucket)) {
      totals.set(url, (totals.get(url) || 0) + count);
    }
  }
  return [...totals.entries()]
    .filter(([, n]) => n >= LAUNCH_FREQ_MIN)
    .sort((a, b) => b[1] - a[1])
    .slice(0, LAUNCH_MAX_TABS)
    .map(([url]) => url);
}

function launchUrlsForEvent(event, keywordMap) {
  const eventUrls = extractUrlsFromEvent(event);
  if (eventUrls.length > 0) {
    return eventUrls.slice(0, LAUNCH_MAX_TABS);
  }

  const keywords = extractKeywords(event.summary);
  const learnedUrls = rankUrlsForKeywords(keywords, keywordMap);
  return learnedUrls.slice(0, LAUNCH_MAX_TABS);
}

function eventEndMs(event) {
  return new Date(event.end?.dateTime || event.end?.date || 0).getTime();
}

async function promptForEvent(event, urls) {
  const eventId = event.id;
  const end = eventEndMs(event);
  const pending = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] || {};
  pending[eventId] = { urls, end };
  const notified = (await chrome.storage.local.get(NOTIFIED_KEY))[NOTIFIED_KEY] || {};
  notified[eventId] = Date.now();
  await chrome.storage.local.set({ [PENDING_KEY]: pending, [NOTIFIED_KEY]: notified });

  await setIconColor("blue");
  await chrome.notifications.create(NOTIF_ID_PREFIX + eventId, {
    type: "basic",
    iconUrl: "icons/icon-blue-128.png",
    title: "Tempo is Ready",
    message: "Should I open your workspace?",
    contextMessage: event.summary || "",
    buttons: [{ title: "Launch" }, { title: "Snooze" }],
    priority: 2,
    requireInteraction: true,
  });
  console.log(`Tempo notify: prompted for "${event.summary}" with ${urls.length} tab(s).`);
}

async function launchPendingEvent(eventId) {
  if (shouldSkipDebouncedLaunch(eventId)) {
    console.log(`Tempo launch: skipped duplicate launch for ${eventId}.`);
    return;
  }
  const pending = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] || {};
  const entry = pending[eventId];
  if (!entry) {
    console.warn(`Tempo launch: no pending entry for ${eventId}.`);
    return;
  }
  const win = await chrome.windows.getLastFocused();
  const activeTabs = win?.id != null
    ? await chrome.tabs.query({ windowId: win.id, active: true })
    : [];
  let insertIndex = activeTabs[0]?.index;
  let openedCount = 0;

  for (const url of entry.urls) {
    const createProperties = {
      url,
      active: openedCount === 0,
    };

    if (win?.id != null) {
      createProperties.windowId = win.id;
    }
    if (typeof insertIndex === "number") {
      insertIndex += 1;
      createProperties.index = insertIndex;
    }

    await chrome.tabs.create(createProperties);
    openedCount += 1;
  }

  if (win?.id != null) {
    await chrome.windows.update(win.id, { focused: true });
  }
  await setIconColor("green");
  delete pending[eventId];
  await chrome.storage.local.set({
    [PENDING_KEY]: pending,
    [LAUNCHED_KEY]: { eventId, end: entry.end },
  });
  chrome.notifications.clear(NOTIF_ID_PREFIX + eventId);
  console.log(`Tempo launch: opened ${openedCount} new tab(s) for event ${eventId}.`);
}

async function executeLaunchFromBackground(eventId) {
  await launchPendingEvent(eventId);
}

async function findEventById(eventId) {
  const events = await fetchUpcomingEvents({ interactive: false });
  return events.find((event) => event.id === eventId) || null;
}

async function launchEventNow(eventId) {
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
  const event = await findEventById(eventId);
  if (!event) {
    throw new Error(`Tempo could not find event ${eventId}.`);
  }

  const urls = launchUrlsForEvent(event, stored);
  if (urls.length === 0) {
    throw new Error("This event has no launchable URLs.");
  }

  const pending = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] || {};
  pending[eventId] = { urls, end: eventEndMs(event) };
  await chrome.storage.local.set({ [PENDING_KEY]: pending });
  await executeLaunchFromBackground(eventId);
}

async function snoozeEvent(eventId) {
  chrome.notifications.clear(NOTIF_ID_PREFIX + eventId);
  const notified = (await chrome.storage.local.get(NOTIFIED_KEY))[NOTIFIED_KEY] || {};
  delete notified[eventId];
  await chrome.storage.local.set({ [NOTIFIED_KEY]: notified });
  chrome.alarms.create(SNOOZE_ALARM_PREFIX + eventId, { delayInMinutes: SNOOZE_DELAY_MIN });
  console.log(`Tempo snooze: re-prompt for ${eventId} in ${SNOOZE_DELAY_MIN} min.`);
}

async function syncIconToState() {
  const launched = (await chrome.storage.local.get(LAUNCHED_KEY))[LAUNCHED_KEY];
  if (launched && Date.now() <= launched.end) {
    await setIconColor("green");
    return "active";
  }
  if (launched) {
    await chrome.storage.local.remove(LAUNCHED_KEY);
  }

  let events;
  try {
    events = await fetchUpcomingEvents();
  } catch {
    await setIconColor("grey");
    return "idle";
  }

  const now = Date.now();
  const liveOrSoon = events.find((e) => {
    const s = new Date(e.start?.dateTime || e.start?.date || 0).getTime();
    const en = new Date(e.end?.dateTime || e.end?.date || 0).getTime();
    if (s <= now && now < en) return true;
    if (s > now && s - now <= 60 * 60 * 1000) return true;
    return false;
  });
  if (liveOrSoon) {
    await setIconColor("blue");
    return "ready";
  }
  await setIconColor("grey");
  return "idle";
}

async function maybeRevertIcon() {
  await syncIconToState();
}

async function tempoNotifyTick() {
  let events;
  try {
    events = await fetchUpcomingEvents({ interactive: false });
  } catch (err) {
    console.warn("Tempo notify: calendar fetch failed:", err.message);
    return;
  }
  await maybeRevertIcon();

  const ev = pickEventStartingSoon(events, NOTIFY_LOOKAHEAD_MS) || pickLaunchableActiveEvent(events);
  if (!ev) return;

  const notified = (await chrome.storage.local.get(NOTIFIED_KEY))[NOTIFIED_KEY] || {};
  if (notified[ev.id]) return;

  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
  const urls = launchUrlsForEvent(ev, stored);
  if (urls.length === 0) return;

  await promptForEvent(ev, urls);
}

async function reprompFromSnooze(eventId) {
  let events;
  try {
    events = await fetchUpcomingEvents({ interactive: false });
  } catch (err) {
    console.warn("Tempo snooze: calendar fetch failed:", err.message);
    return;
  }
  const ev = events.find((e) => e.id === eventId);
  if (!ev) return;
  if (eventEndMs(ev) <= Date.now()) return;

  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
  const urls = launchUrlsForEvent(ev, stored);
  if (urls.length === 0) return;

  await promptForEvent(ev, urls);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === NOTIFY_ALARM) {
    tempoNotifyTick();
  } else if (alarm.name.startsWith(SNOOZE_ALARM_PREFIX)) {
    reprompFromSnooze(alarm.name.slice(SNOOZE_ALARM_PREFIX.length));
  }
});

chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
  if (!notifId.startsWith(NOTIF_ID_PREFIX)) return;
  const eventId = notifId.slice(NOTIF_ID_PREFIX.length);
  if (btnIdx === 0) executeLaunchFromBackground(eventId);
  else if (btnIdx === 1) snoozeEvent(eventId);
});

chrome.notifications.onClicked.addListener((notifId) => {
  if (!notifId.startsWith(NOTIF_ID_PREFIX)) return;
  const eventId = notifId.slice(NOTIF_ID_PREFIX.length);
  executeLaunchFromBackground(eventId);
});

chrome.notifications.onClosed.addListener(async (notifId) => {
  if (!notifId.startsWith(NOTIF_ID_PREFIX)) return;
  const eventId = notifId.slice(NOTIF_ID_PREFIX.length);
  const pending = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] || {};
  if (pending[eventId]) {
    delete pending[eventId];
    await chrome.storage.local.set({ [PENDING_KEY]: pending });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(NOTIFY_ALARM, { periodInMinutes: NOTIFY_PERIOD_MIN });
  syncIconToState().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(NOTIFY_ALARM, { periodInMinutes: NOTIFY_PERIOD_MIN });
  syncIconToState().catch(() => {});
});

self.tempoNotifyTick = tempoNotifyTick;
self.launchPendingEvent = launchPendingEvent;
self.snoozeEvent = snoozeEvent;

function firstKeywordFromEvent(event) {
  return extractKeywords(event?.summary || "")[0] || null;
}

async function writePopupStatus(event = null) {
  await chrome.storage.local.set({
    [POPUP_STATUS_KEY]: {
      title: event?.summary || null,
      keywords: extractKeywords(event?.summary || ""),
      updatedAt: Date.now(),
    },
  });
}

function summarizeEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    summary: event.summary || null,
    startMs: new Date(event.start?.dateTime || event.start?.date || 0).getTime(),
    endMs: new Date(event.end?.dateTime || event.end?.date || 0).getTime(),
    hangoutLink: event.hangoutLink || meetingLinkFor(event) || null,
  };
}

async function getPopupDashboardState() {
  let token;
  try {
    token = await getAuthToken({ interactive: false });
  } catch {
    return {
      authenticated: false,
      state: "idle",
      currentKeyword: null,
      observedUrls: [],
      currentEvent: null,
      upcomingEvents: [],
    };
  }

  try {
    const events = await fetchUpcomingEvents({ interactive: false });
    const currentEvent = pickCurrentOrUpcoming(events);
    const currentKeyword = firstKeywordFromEvent(currentEvent);
    await writePopupStatus(currentEvent);
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
    const currentLaunchUrls = currentEvent ? launchUrlsForEvent(currentEvent, stored) : [];
    const observedUrls = currentKeyword
      ? Object.entries(stored[currentKeyword] || {})
          .sort((a, b) => b[1] - a[1])
          .map(([url, count]) => ({ url, count }))
      : [];

    const upcomingEvents = events
      .filter((e) => e.id !== currentEvent?.id)
      .map(summarizeEvent)
      .filter((e) => e && e.startMs > Date.now())
      .slice(0, 4);

    return {
      authenticated: true,
      state: "active",
      currentKeyword,
      observedUrls,
      eventTitle: currentEvent?.summary || null,
      currentEvent: summarizeEvent(currentEvent),
      currentLaunchUrls,
      upcomingEvents,
      tokenPresent: Boolean(token),
    };
  } catch (err) {
    console.warn("Tempo popup: failed to build dashboard state:", err.message);
    return {
      authenticated: true,
      state: "active",
      currentKeyword: null,
      observedUrls: [],
      eventTitle: null,
      currentEvent: null,
      currentLaunchUrls: [],
      upcomingEvents: [],
      tokenPresent: Boolean(token),
      error: err.message,
    };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "tempo:get-popup-state") {
    getPopupDashboardState()
      .then(async (payload) => {
        await syncIconToState().catch(() => {});
        sendResponse({ ok: true, ...payload });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "tempo:authenticate") {
    getAuthToken({ interactive: true })
      .then(() => getPopupDashboardState())
      .then(async (payload) => {
        await syncIconToState().catch(() => {});
        sendResponse({ ok: true, ...payload });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "tempo:mark-launched") {
    executeLaunchFromBackground(message.eventId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "tempo:get-current-user") {
    chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }, (info) => {
      sendResponse({ ok: true, email: info?.email || null });
    });
    return true;
  }

  if (message?.type === "tempo:sign-out") {
    signOut()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "tempo:refresh-popup-status") {
    fetchUpcomingEvents({ interactive: false })
      .then((events) => {
        const currentEvent = pickCurrentOrUpcoming(events);
        return writePopupStatus(currentEvent).then(() => ({
          title: currentEvent?.summary || null,
          keywords: extractKeywords(currentEvent?.summary || ""),
        }));
      })
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "tempo:launch-event") {
    launchEventNow(message.eventId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "tempo:snooze-event") {
    snoozeEvent(message.eventId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function signOut() {
  let token = null;
  try {
    token = await getAuthToken({ interactive: false });
  } catch {}

  if (token) {
    await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
    try {
      await fetch(
        `https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(token)}`
      );
    } catch {}
  }
  await new Promise((r) => chrome.identity.clearAllCachedAuthTokens(r));

  // Drop session-scoped state but keep learned keyword data so a future re-auth
  // doesn't lose the user's behavior history.
  await chrome.storage.local.remove([
    POPUP_STATUS_KEY,
    PENDING_KEY,
    NOTIFIED_KEY,
    LAUNCHED_KEY,
  ]);

  // Cancel any outstanding snooze alarms.
  const alarms = await chrome.alarms.getAll();
  for (const a of alarms) {
    if (a.name.startsWith(SNOOZE_ALARM_PREFIX)) {
      chrome.alarms.clear(a.name);
    }
  }

  await setIconColor("grey");
}

self.getPopupDashboardState = getPopupDashboardState;
self.signOut = signOut;
self.launchEventNow = launchEventNow;
