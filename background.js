console.log("Extension Active");

<<<<<<< HEAD
// ─── Gemini + history-based learning ──────────────────────────────────────
const GEMINI_MODEL_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";
const GEMINI_TIMEOUT_MS = 10_000;
const LEARNING_CAPTURE_LIMIT = 60;
const LEARNING_BUCKET_LIMIT = 50;
=======
// ════════════════════════════════════════════════════════════════════════
//  CONSTANTS  — every value the rest of the file depends on, in one place.
// ════════════════════════════════════════════════════════════════════════

const GEMINI_MODEL_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";
const CALENDAR_API =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

const ICON_STATES = ["grey", "blue", "green"];
const ICON_SIZES = [16, 32, 48, 128];

// Storage keys
const STORAGE_KEY            = "keywords";          // { [keyword]: { [url]: count } }
const CATEGORY_DOMAINS_KEY   = "categoryDomains";   // { [category]: { [domain]: score } }
const CATEGORY_CACHE_KEY     = "categoryCache";     // { [eventId]: { category, ts } }
const PROCESSED_EVENTS_KEY   = "processedEvents";   // { [eventId]: { done, attempts, ts } }
const LAST_ACTIVE_KEY        = "lastActiveEvent";   // { id, summary, startMs, endMs }
const PENDING_KEY            = "pendingLaunches";   // { [eventId]: { urls, end } }
const NOTIFIED_KEY           = "notifiedEventIds";  // { [eventId]: ts }
const LAUNCHED_KEY           = "launchedEvent";     // { eventId, end }
const POPUP_STATUS_KEY       = "popupStatus";       // { title, keywords, updatedAt }

// Alarm + notification names
const LEARN_ALARM            = "tempo-learn";
const NOTIFY_ALARM           = "tempo-notify";
const SNOOZE_ALARM_PREFIX    = "tempo-snooze:";
const NOTIF_ID_PREFIX        = "tempo-notif:";

// Periods + windows
const LEARN_PERIOD_MIN       = 5;
const NOTIFY_PERIOD_MIN      = 1;
const SNOOZE_DELAY_MIN       = 5;
const NOTIFY_LOOKAHEAD_MS    = 10 * 60 * 1000;        // notify when start ≤ 10 min away
const READY_HORIZON_MS       = NOTIFY_LOOKAHEAD_MS;   // icon = blue when start ≤ same window
const LAUNCH_FREQ_MIN        = 2;
const LAUNCH_MAX_TABS        = 8;
const CATEGORY_CACHE_TTL_MS  = 7 * 24 * 60 * 60 * 1000;
const PROCESSED_RETRY_MAX    = 3;
const HISTORY_VISITS_PARALLEL = 8;

const ZOOM_URL_RE = /https:\/\/[\w.-]*zoom\.us\/[^\s<>"')]+/i;
const URL_RE      = /https?:\/\/[^\s<>"')]+/gi;

const STOP_WORDS = new Set([
  "a", "an", "and", "the", "or", "of", "for", "to", "with", "in", "on", "at",
  "by", "from", "is", "are", "be", "as", "vs", "via",
  "meeting", "meet", "sync", "syncs", "call", "calls", "chat", "standup",
  "stand-up", "1on1", "1-on-1", "1:1", "weekly", "daily", "monthly", "review",
  "check-in", "checkin", "catchup", "catch-up", "discussion", "discuss",
]);
>>>>>>> fc908d0 (backend updates)

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

// ════════════════════════════════════════════════════════════════════════
//  LAZY GEMINI KEY LOADER  — replaces top-level await so listener
//  registration is never delayed past the SW wake-up window.
// ════════════════════════════════════════════════════════════════════════

let __keyPromise = null;
function getGeminiKey() {
  if (!__keyPromise) {
    __keyPromise = import("./config.local.js")
      .then((m) => m.GEMINI_API_KEY || "")
      .catch((err) => {
        console.warn(
          "[config] config.local.js missing — run `node scripts/build-config.mjs` to enable Gemini.",
          err?.message
        );
        return "";
      });
  }
  return __keyPromise;
}

// ════════════════════════════════════════════════════════════════════════
//  STORAGE LOCK  — per-key serialization of read-modify-write sequences.
//  Every helper that does `get → mutate → set` MUST go through this.
// ════════════════════════════════════════════════════════════════════════

const __locks = new Map();
function withStorageLock(key, fn) {
  const prev = __locks.get(key) || Promise.resolve();
  // Errors in `fn` don't poison subsequent waiters: each attempt re-runs `fn`.
  const next = prev.then(() => fn(), () => fn());
  const stored = next.catch(() => {});
  __locks.set(key, stored);
  // GC: drop the entry once nothing's queued behind it.
  stored.then(() => {
    if (__locks.get(key) === stored) __locks.delete(key);
  });
  return next;
}

// Convenience for atomic single-key updates.
async function updateStorageKey(key, mutator) {
  return withStorageLock(key, async () => {
    const got = await chrome.storage.local.get(key);
    const current = got[key];
    const updated = await mutator(current);
    if (updated === undefined) return current;
    await chrome.storage.local.set({ [key]: updated });
    return updated;
  });
}

// ════════════════════════════════════════════════════════════════════════
//  PURE HELPERS  — no chrome.* state, no I/O.
// ════════════════════════════════════════════════════════════════════════

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

<<<<<<< HEAD
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
=======
function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "www.google.com" && parsed.pathname === "/url") {
      const target = parsed.searchParams.get("q");
      if (target) return normalizeUrl(target);
>>>>>>> fc908d0 (backend updates)
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
  for (const u of extractUrlsFromText(event?.location)) urls.add(u);
  for (const u of extractUrlsFromText(event?.description)) urls.add(u);
  if (event?.hangoutLink) urls.add(normalizeUrl(event.hangoutLink));
  for (const att of event?.attachments || []) {
    if (att?.fileUrl) urls.add(normalizeUrl(att.fileUrl));
  }
  return [...urls];
}

function meetingLinkFor(event) {
  if (event?.hangoutLink) return event.hangoutLink;
  const m = event?.description?.match(ZOOM_URL_RE);
  return m ? m[0] : null;
}

function eventStartMs(event) {
  const v = event?.start?.dateTime || event?.start?.date;
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
}
function eventEndMs(event) {
  const v = event?.end?.dateTime || event?.end?.date;
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
}

function summarizeEvent(event) {
  if (!event) return null;
  const startMs = eventStartMs(event);
  const endMs   = eventEndMs(event);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return {
    id: event.id,
    summary: event.summary || null,
    startMs,
    endMs,
    hangoutLink: event.hangoutLink || meetingLinkFor(event) || null,
  };
}

function extractKeywords(title) {
  if (!title) return [];
  return [...new Set(
    title.toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
  )];
}

// ─── Event-set picks (split semantically per review Bug 5) ──────────────

function findCurrentlyActiveEvent(events) {
  const now = Date.now();
  for (const ev of events) {
    const s = eventStartMs(ev);
    const e = eventEndMs(ev);
    if (Number.isFinite(s) && Number.isFinite(e) && s <= now && now < e) return ev;
  }
  return null;
}

<<<<<<< HEAD
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
=======
function findNextUpcomingEvent(events) {
  const now = Date.now();
  let best = null;
  let bestStart = Infinity;
  for (const ev of events) {
    const s = eventStartMs(ev);
    if (Number.isFinite(s) && s > now && s < bestStart) {
      best = ev;
      bestStart = s;
    }
>>>>>>> fc908d0 (backend updates)
  }
  return best;
}

function findEventStartingWithin(events, withinMs) {
  const now = Date.now();
  let best = null;
  let bestStart = Infinity;
  for (const ev of events) {
    const s = eventStartMs(ev);
    if (Number.isFinite(s) && s > now && s - now <= withinMs && s < bestStart) {
      best = ev;
      bestStart = s;
    }
  }
  return best;
}

function rankUrlsForKeywords(keywords, keywordMap) {
  const totals = new Map();
  for (const kw of keywords) {
    const bucket = keywordMap?.[kw];
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

// ════════════════════════════════════════════════════════════════════════
//  ICON
// ════════════════════════════════════════════════════════════════════════

function iconPaths(state) {
  const paths = {};
  for (const size of ICON_SIZES) paths[size] = `icons/icon-${state}-${size}.png`;
  return paths;
}

function setIconColor(state) {
  if (!ICON_STATES.includes(state)) {
    return Promise.reject(
      new Error(`Unknown icon state: ${state}. Expected one of ${ICON_STATES.join(", ")}.`)
    );
  }
  return chrome.action.setIcon({ path: iconPaths(state) });
}

function setIconColorSafe(state) {
  return setIconColor(state).catch((err) =>
    console.warn(`[icon] setIcon(${state}) failed:`, err?.message)
  );
}

// ════════════════════════════════════════════════════════════════════════
//  CALENDAR
// ════════════════════════════════════════════════════════════════════════

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

async function findEventById(eventId) {
  const events = await fetchUpcomingEvents({ interactive: false });
  return events.find((e) => e.id === eventId) || null;
}

// ════════════════════════════════════════════════════════════════════════
//  GEMINI — categorization, lazy key, no key = graceful no-op
// ════════════════════════════════════════════════════════════════════════

async function categorizeEvent(eventTitle) {
  const key = await getGeminiKey();
  if (!key) {
    console.log("[categorizeEvent] no API key, skipping");
    return null;
  }
  if (!eventTitle) return null;

  const prompt =
    `Categorize this calendar event title into a single, lowercase, ` +
    `one-word category (e.g., finance, design, engineering, sync, personal): ` +
    `${eventTitle}`;

  try {
    const res = await fetch(`${GEMINI_MODEL_URL}?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8 },
      }),
    });
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

// ════════════════════════════════════════════════════════════════════════
//  HISTORY — per-visit accurate scoring + locked storage merge
// ════════════════════════════════════════════════════════════════════════

function getVisitsForUrl(url) {
  return new Promise((resolve) => {
    chrome.history.getVisits({ url }, (visits) => {
      if (chrome.runtime.lastError) {
        console.warn("[getVisits] error:", chrome.runtime.lastError.message);
        resolve([]);
        return;
      }
      resolve(visits || []);
    });
  });
}

async function mapWithPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function learnFromHistory(category, meetingStartTime, meetingEndTime) {
  if (!category) return [];
  if (!Number.isFinite(meetingStartTime) || !Number.isFinite(meetingEndTime)
      || meetingEndTime <= meetingStartTime) {
    console.warn("[learnFromHistory] invalid window", { meetingStartTime, meetingEndTime });
    return [];
  }

  const items = await new Promise((resolve) => {
    chrome.history.search(
      { text: "", startTime: meetingStartTime, endTime: meetingEndTime, maxResults: 1000 },
      (results) => {
        if (chrome.runtime.lastError) {
          console.warn("[learnFromHistory] history.search error:",
            chrome.runtime.lastError.message);
          resolve([]);
          return;
        }
        resolve(results || []);
      }
    );
  });

  // Pre-filter noise + invalid domains so the (slow) getVisits loop stays small.
  const filtered = [];
  for (const item of items) {
    if (isNoiseUrl(item.url)) continue;
    const domain = domainFromUrl(item.url);
    if (!domain) continue;
    filtered.push({ url: item.url, domain });
  }

  // Bounded-parallel per-visit counting. +1 per in-window visit (NOT lifetime visitCount).
  const perItem = await mapWithPool(filtered, HISTORY_VISITS_PARALLEL, async ({ url, domain }) => {
    const visits = await getVisitsForUrl(url);
    let inWindow = 0;
    for (const v of visits) {
      if (Number.isFinite(v.visitTime)
          && v.visitTime >= meetingStartTime
          && v.visitTime <= meetingEndTime) {
        inWindow += 1;
      }
    }
    return { domain, inWindow };
  });

  const domainCounts = new Map();
  let total = 0;
  for (const { domain, inWindow } of perItem) {
    if (inWindow === 0) continue;
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + inWindow);
    total += inWindow;
  }
  console.log(
    `[learnFromHistory] category="${category}" inWindowVisits=${total} uniqueDomains=${domainCounts.size}`
  );

  // Atomic merge into the persistent {category: {domain: score}} map.
  await updateStorageKey(CATEGORY_DOMAINS_KEY, (current) => {
    const all = current || {};
    const bucket = all[category] || {};
    for (const [domain, count] of domainCounts) {
      bucket[domain] = (bucket[domain] || 0) + count;
    }
    all[category] = bucket;
    return all;
  });

  return [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([d]) => d);
}

// ════════════════════════════════════════════════════════════════════════
//  PREDICTIVE PIPELINE
// ════════════════════════════════════════════════════════════════════════

// Cached per event id; cache write is lock-protected.
async function getOrCacheCategory(event) {
  if (!event?.id || !event?.summary) return null;
  const got = await chrome.storage.local.get(CATEGORY_CACHE_KEY);
  const hit = got[CATEGORY_CACHE_KEY]?.[event.id];
  if (hit?.category && Number.isFinite(hit.ts)
      && Date.now() - hit.ts < CATEGORY_CACHE_TTL_MS) {
    return hit.category;
  }
  const category = await categorizeEvent(event.summary);
  if (category) {
    await updateStorageKey(CATEGORY_CACHE_KEY, (current) => {
      const cache = current || {};
      cache[event.id] = { category, ts: Date.now() };
      return cache;
    });
  }
  return category;
}

async function predictUrlsForCategory(category, limit = LAUNCH_MAX_TABS) {
  if (!category) return [];
  const got = await chrome.storage.local.get(CATEGORY_DOMAINS_KEY);
  const bucket = got[CATEGORY_DOMAINS_KEY]?.[category] || {};
  return Object.entries(bucket)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([domain]) => `https://${domain}/`);
}

// Three-tier resolver:
//   1) explicit URLs in the event,
//   2) keyword-ranked URLs from observed-tab learning,
//   3) Gemini-derived category → top history-scored domains.
async function predictLaunchUrlsForEvent(event, keywordMap) {
  const explicit = extractUrlsFromEvent(event);
  if (explicit.length > 0) return explicit.slice(0, LAUNCH_MAX_TABS);

  const learned = rankUrlsForKeywords(extractKeywords(event?.summary), keywordMap);
  if (learned.length > 0) return learned.slice(0, LAUNCH_MAX_TABS);

  const category = await getOrCacheCategory(event);
  if (!category) return [];
  const predicted = await predictUrlsForCategory(category);
  if (predicted.length > 0) {
    console.log(
      `[predict] "${event.summary}" → category "${category}" → ${predicted.length} url(s)`
    );
  }
  return predicted;
}

// Post-event hook. Idempotent + retry-aware:
//   - never stamps `done` until the learn pipeline succeeds,
//   - tracks an `attempts` counter so transient Gemini/history failures retry,
//   - silently drops permanently malformed events (start/end missing).
async function processFinishedEvent(eventSummary) {
  if (!eventSummary?.id) return;
  if (!Number.isFinite(eventSummary.startMs)
      || !Number.isFinite(eventSummary.endMs)
      || eventSummary.endMs <= eventSummary.startMs) {
    console.warn("[post-hook] malformed event, skipping", eventSummary?.id);
    return;
  }

  // Read current dedup state to decide whether to attempt.
  const got = await chrome.storage.local.get(PROCESSED_EVENTS_KEY);
  const current = got[PROCESSED_EVENTS_KEY]?.[eventSummary.id];
  if (current?.done) return;
  if ((current?.attempts || 0) >= PROCESSED_RETRY_MAX) return;

  const category = await getOrCacheCategory({
    id: eventSummary.id,
    summary: eventSummary.summary,
  });

  if (!category) {
    await updateStorageKey(PROCESSED_EVENTS_KEY, (cur) => {
      const map = cur || {};
      const prev = map[eventSummary.id];
      map[eventSummary.id] = {
        done: false,
        attempts: (prev?.attempts || 0) + 1,
        ts: Date.now(),
      };
      return map;
    });
    console.log(`[post-hook] "${eventSummary.summary}" — no category yet, will retry`);
    return;
  }

  await learnFromHistory(category, eventSummary.startMs, eventSummary.endMs);

  await updateStorageKey(PROCESSED_EVENTS_KEY, (cur) => {
    const map = cur || {};
    map[eventSummary.id] = { done: true, attempts: (current?.attempts || 0) + 1, ts: Date.now() };
    // Garbage-collect anything older than 30 days.
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const id of Object.keys(map)) {
      if ((map[id].ts || 0) < cutoff) delete map[id];
    }
    return map;
  });
}

// Edge-detect "active event just ended" via persistent lastActive snapshot.
async function detectAndProcessEndedEvent(events) {
  const now = Date.now();
  const got = await chrome.storage.local.get(LAST_ACTIVE_KEY);
  const lastActive = got[LAST_ACTIVE_KEY] || null;
  const currentlyActive = findCurrentlyActiveEvent(events);

  if (lastActive
      && (!currentlyActive || currentlyActive.id !== lastActive.id)
      && Number.isFinite(lastActive.endMs)
      && now > lastActive.endMs) {
    console.log(`[post-hook] detected end of "${lastActive.summary}"`);
    try {
      await processFinishedEvent(lastActive);
    } catch (err) {
      console.warn("[post-hook] failed:", err?.message);
    }
    await updateStorageKey(LAST_ACTIVE_KEY, () => null);
  }

  if (currentlyActive) {
    const summary = summarizeEvent(currentlyActive);
    if (summary) {
      await updateStorageKey(LAST_ACTIVE_KEY, () => summary);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
//  KEYWORD-LEARNING (5-min observation while an event is active)
// ════════════════════════════════════════════════════════════════════════

async function getActiveWindowTabUrls() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: true });
    return (win?.tabs || [])
      .map((t) => t.url)
      .filter((u) => u && /^https?:\/\//i.test(u));
  } catch (err) {
    console.warn("[learn] getLastFocused failed:", err?.message);
    return [];
  }
}

async function recordTabsForActiveEvent() {
  let events;
  try {
    events = await fetchUpcomingEvents({ interactive: false });
  } catch (err) {
    console.warn("[learn] calendar fetch failed:", err.message);
    return;
  }
  const ev = findCurrentlyActiveEvent(events);
  if (!ev) return;

  const keywords = extractKeywords(ev.summary);
  if (keywords.length === 0) return;

  const sanitizedUrls = [...new Set(
    (await getActiveWindowTabUrls())
      .map(sanitizeLearningUrl)
      .filter(Boolean)
  )].slice(0, LEARNING_CAPTURE_LIMIT);
  if (sanitizedUrls.length === 0) return;

<<<<<<< HEAD
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
=======
  await updateStorageKey(STORAGE_KEY, (current) => {
    const stored = current || {};
    for (const kw of keywords) {
      const bucket = stored[kw] || {};
      for (const url of urls) bucket[url] = (bucket[url] || 0) + 1;
      stored[kw] = bucket;
    }
    return stored;
  });

  console.log(
    `[learn] "${ev.summary}" → keywords [${keywords.join(", ")}], +${urls.length} tab(s)`
  );
}

// ════════════════════════════════════════════════════════════════════════
//  NOTIFICATION + LAUNCH FLOW
// ════════════════════════════════════════════════════════════════════════
>>>>>>> fc908d0 (backend updates)

async function promptForEvent(event, urls) {
  const eventId = event.id;
  const end = eventEndMs(event);

  // Single locked transaction over both keys.
  await withStorageLock("__pendingNotified", async () => {
    const got = await chrome.storage.local.get([PENDING_KEY, NOTIFIED_KEY]);
    const pending = got[PENDING_KEY] || {};
    const notified = got[NOTIFIED_KEY] || {};
    pending[eventId] = { urls, end };
    notified[eventId] = Date.now();
    await chrome.storage.local.set({ [PENDING_KEY]: pending, [NOTIFIED_KEY]: notified });
  });

  await setIconColorSafe("blue");
  try {
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
    console.log(`[notify] prompted for "${event.summary}" with ${urls.length} tab(s)`);
  } catch (err) {
    console.warn("[notify] notifications.create failed:", err?.message);
  }
}

async function launchPendingEvent(eventId) {
<<<<<<< HEAD
  if (shouldSkipDebouncedLaunch(eventId)) {
    console.log(`Tempo launch: skipped duplicate launch for ${eventId}.`);
    return;
  }
  const pending = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] || {};
  const entry = pending[eventId];
=======
  // Read entry under the same lock that promptForEvent uses, then carve it out.
  const entry = await withStorageLock("__pendingNotified", async () => {
    const got = await chrome.storage.local.get(PENDING_KEY);
    const pending = got[PENDING_KEY] || {};
    const e = pending[eventId];
    if (!e) return null;
    delete pending[eventId];
    await chrome.storage.local.set({ [PENDING_KEY]: pending });
    return e;
  });
>>>>>>> fc908d0 (backend updates)
  if (!entry) {
    console.warn(`[launch] no pending entry for ${eventId}`);
    return;
  }

  let win = null;
  try { win = await chrome.windows.getLastFocused(); } catch {}
  const activeTabs = win?.id != null
    ? await chrome.tabs.query({ windowId: win.id, active: true }).catch(() => [])
    : [];
  let insertIndex = activeTabs[0]?.index;
  let openedCount = 0;

  for (const url of entry.urls) {
    const props = { url, active: openedCount === 0 };
    if (win?.id != null) props.windowId = win.id;
    if (typeof insertIndex === "number") {
      insertIndex += 1;
      props.index = insertIndex;
    }
    try {
      await chrome.tabs.create(props);
      openedCount += 1;
    } catch (err) {
      console.warn(`[launch] tabs.create failed for ${url}:`, err?.message);
    }
  }

  if (win?.id != null) {
    try { await chrome.windows.update(win.id, { focused: true }); }
    catch (err) { console.warn("[launch] windows.update failed:", err?.message); }
  }

<<<<<<< HEAD
async function executeLaunchFromBackground(eventId) {
  await launchPendingEvent(eventId);
}

async function findEventById(eventId) {
  const events = await fetchUpcomingEvents({ interactive: false });
  return events.find((event) => event.id === eventId) || null;
=======
  await updateStorageKey(LAUNCHED_KEY, () => ({ eventId, end: entry.end }));
  await setIconColorSafe("green");
  await chrome.notifications.clear(NOTIF_ID_PREFIX + eventId).catch(() => {});
  console.log(`[launch] opened ${openedCount} tab(s) for ${eventId}`);
>>>>>>> fc908d0 (backend updates)
}

async function launchEventNow(eventId) {
  const event = await findEventById(eventId);
  if (!event) throw new Error(`Tempo could not find event ${eventId}.`);

  const got = await chrome.storage.local.get(STORAGE_KEY);
  const stored = got[STORAGE_KEY] || {};
  const urls = await predictLaunchUrlsForEvent(event, stored);
  if (urls.length === 0) throw new Error("This event has no launchable URLs.");

<<<<<<< HEAD
  const pending = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] || {};
  pending[eventId] = { urls, end: eventEndMs(event) };
  await chrome.storage.local.set({ [PENDING_KEY]: pending });
  await executeLaunchFromBackground(eventId);
=======
  await withStorageLock("__pendingNotified", async () => {
    const cur = await chrome.storage.local.get(PENDING_KEY);
    const pending = cur[PENDING_KEY] || {};
    pending[eventId] = { urls, end: eventEndMs(event) };
    await chrome.storage.local.set({ [PENDING_KEY]: pending });
  });
  await launchPendingEvent(eventId);
>>>>>>> fc908d0 (backend updates)
}

async function snoozeEvent(eventId) {
  await chrome.notifications.clear(NOTIF_ID_PREFIX + eventId).catch(() => {});
  await updateStorageKey(NOTIFIED_KEY, (current) => {
    const map = current || {};
    delete map[eventId];
    return map;
  });
  await chrome.alarms.create(SNOOZE_ALARM_PREFIX + eventId, { delayInMinutes: SNOOZE_DELAY_MIN });
  console.log(`[snooze] re-prompt ${eventId} in ${SNOOZE_DELAY_MIN} min`);
}

// ════════════════════════════════════════════════════════════════════════
//  ICON STATE MACHINE
// ════════════════════════════════════════════════════════════════════════

async function syncIconToState() {
  const got = await chrome.storage.local.get(LAUNCHED_KEY);
  const launched = got[LAUNCHED_KEY];
  if (launched && Number.isFinite(launched.end) && Date.now() <= launched.end) {
    await setIconColorSafe("green");
    return "active";
  }
  if (launched) {
    await updateStorageKey(LAUNCHED_KEY, () => undefined).catch(() => {});
    // updateStorageKey writes only when mutator returns non-undefined — emulate remove:
    await chrome.storage.local.remove(LAUNCHED_KEY).catch(() => {});
  }

  let events;
  try {
    events = await fetchUpcomingEvents({ interactive: false });
  } catch {
    await setIconColorSafe("grey");
    return "idle";
  }

  const now = Date.now();
  const liveOrSoon = events.find((e) => {
    const s = eventStartMs(e);
    const en = eventEndMs(e);
    if (Number.isFinite(s) && Number.isFinite(en) && s <= now && now < en) return true;
    if (Number.isFinite(s) && s > now && s - now <= READY_HORIZON_MS) return true;
    return false;
  });
  if (liveOrSoon) {
    await setIconColorSafe("blue");
    return "ready";
  }
  await setIconColorSafe("grey");
  return "idle";
}

// ════════════════════════════════════════════════════════════════════════
//  NOTIFY TICK — reentrancy-guarded
// ════════════════════════════════════════════════════════════════════════

let __notifyTickRunning = false;
async function tempoNotifyTick() {
  if (__notifyTickRunning) {
    console.log("[notify] tick already in flight, skipping");
    return;
  }
  __notifyTickRunning = true;
  try {
    let events;
    try {
      events = await fetchUpcomingEvents({ interactive: false });
    } catch (err) {
      console.warn("[notify] calendar fetch failed:", err.message);
      return;
    }

    await syncIconToState().catch((err) =>
      console.warn("[notify] syncIconToState failed:", err?.message)
    );

    // Run post-event hook (categorize + history-learn) for any event that
    // was active and has now ended.
    await detectAndProcessEndedEvent(events).catch((err) =>
      console.warn("[notify] post-hook failed:", err?.message)
    );

    // Pick the imminent event: prefer something starting within the lookahead;
    // otherwise grab whatever is live right now.
    const upcoming = findEventStartingWithin(events, NOTIFY_LOOKAHEAD_MS);
    const ev = upcoming || findCurrentlyActiveEvent(events);
    if (!ev) return;

    // Atomic dedup check + reservation: if not yet notified, we'll prompt.
    const reserved = await withStorageLock("__pendingNotified", async () => {
      const got = await chrome.storage.local.get(NOTIFIED_KEY);
      const notified = got[NOTIFIED_KEY] || {};
      if (notified[ev.id]) return false;
      // Don't stamp here — promptForEvent stamps inside the same lock.
      return true;
    });
    if (!reserved) return;

    const got = await chrome.storage.local.get(STORAGE_KEY);
    const stored = got[STORAGE_KEY] || {};
    const urls = await predictLaunchUrlsForEvent(ev, stored);
    if (urls.length === 0) return;

    await promptForEvent(ev, urls);
  } finally {
    __notifyTickRunning = false;
  }
}

async function reprompFromSnooze(eventId) {
  let events;
  try {
    events = await fetchUpcomingEvents({ interactive: false });
  } catch (err) {
    console.warn("[snooze] calendar fetch failed:", err.message);
    return;
  }
  const ev = events.find((e) => e.id === eventId);
  if (!ev) return;
  if (eventEndMs(ev) <= Date.now()) return;

  const got = await chrome.storage.local.get(STORAGE_KEY);
  const stored = got[STORAGE_KEY] || {};
  const urls = await predictLaunchUrlsForEvent(ev, stored);
  if (urls.length === 0) return;

  await promptForEvent(ev, urls);
}

// ════════════════════════════════════════════════════════════════════════
//  POPUP STATE
// ════════════════════════════════════════════════════════════════════════

<<<<<<< HEAD
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
=======
async function writePopupStatus(event = null) {
  await updateStorageKey(POPUP_STATUS_KEY, () => ({
    title: event?.summary || null,
    keywords: extractKeywords(event?.summary || ""),
    updatedAt: Date.now(),
  }));
}
>>>>>>> fc908d0 (backend updates)

function firstKeywordFromEvent(event) {
  return extractKeywords(event?.summary || "")[0] || null;
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

    const liveEvent = findCurrentlyActiveEvent(events);
    const nextEvent = findNextUpcomingEvent(events);
    const currentEvent = liveEvent || nextEvent;
    const currentKeyword = firstKeywordFromEvent(currentEvent);

    await writePopupStatus(currentEvent);

    const got = await chrome.storage.local.get(STORAGE_KEY);
    const stored = got[STORAGE_KEY] || {};

    // Only burn a Gemini call when the event is actually imminent.
    let currentLaunchUrls = [];
    if (currentEvent) {
      const isImminent = liveEvent
        || (Number.isFinite(eventStartMs(currentEvent))
            && eventStartMs(currentEvent) - Date.now() <= NOTIFY_LOOKAHEAD_MS);
      if (isImminent) {
        currentLaunchUrls = await predictLaunchUrlsForEvent(currentEvent, stored);
      } else {
        // Cheap path: only the first two tiers, no Gemini call.
        const explicit = extractUrlsFromEvent(currentEvent);
        currentLaunchUrls = explicit.length > 0
          ? explicit.slice(0, LAUNCH_MAX_TABS)
          : rankUrlsForKeywords(extractKeywords(currentEvent.summary), stored);
      }
    }

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
    console.warn("[popup] failed to build dashboard state:", err.message);
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

<<<<<<< HEAD
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
=======
// ════════════════════════════════════════════════════════════════════════
//  SIGN-OUT
// ════════════════════════════════════════════════════════════════════════
>>>>>>> fc908d0 (backend updates)

async function signOut() {
  let token = null;
  try { token = await getAuthToken({ interactive: false }); } catch {}

  if (token) {
    await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
    try {
      await fetch(
        `https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(token)}`
      );
    } catch {}
  }
  await new Promise((r) => chrome.identity.clearAllCachedAuthTokens(r));

  // Drop session-scoped state. Preserve `keywords` and `categoryDomains`
  // so that re-signing in retains the user's learned associations.
  await chrome.storage.local.remove([
    POPUP_STATUS_KEY,
    PENDING_KEY,
    NOTIFIED_KEY,
    LAUNCHED_KEY,
    LAST_ACTIVE_KEY,
  ]);

  // Cancel any pending snooze alarms — awaited so they cannot fire post-signout.
  const alarms = await chrome.alarms.getAll();
  await Promise.all(
    alarms
      .filter((a) => a.name.startsWith(SNOOZE_ALARM_PREFIX))
      .map((a) => chrome.alarms.clear(a.name).catch(() => {}))
  );

  await setIconColorSafe("grey");
}

// ════════════════════════════════════════════════════════════════════════
//  LIFECYCLE — single onInstalled, single onStartup, single onAlarm.
//  Listeners must register synchronously during top-level evaluation so
//  Chrome can wake the SW on cold-start events. No top-level await above.
// ════════════════════════════════════════════════════════════════════════

function ensureRecurringAlarms() {
  // create() with the same name overwrites, so this is idempotent.
  chrome.alarms.create(LEARN_ALARM,  { periodInMinutes: LEARN_PERIOD_MIN });
  chrome.alarms.create(NOTIFY_ALARM, { periodInMinutes: NOTIFY_PERIOD_MIN });
}

async function masterStartup({ fresh }) {
  if (fresh) {
    await setIconColorSafe("grey");
  }
  ensureRecurringAlarms();
  await syncIconToState().catch((err) =>
    console.warn("[startup] syncIconToState failed:", err?.message)
  );
}

chrome.runtime.onInstalled.addListener(() => {
  masterStartup({ fresh: true }).catch((err) =>
    console.warn("[onInstalled] failed:", err?.message)
  );
});

chrome.runtime.onStartup.addListener(() => {
  masterStartup({ fresh: false }).catch((err) =>
    console.warn("[onStartup] failed:", err?.message)
  );
});

// Single dispatcher for every alarm name.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm?.name) return;
  if (alarm.name === LEARN_ALARM) {
    recordTabsForActiveEvent().catch((err) =>
      console.warn("[alarm:learn] failed:", err?.message));
    return;
  }
  if (alarm.name === NOTIFY_ALARM) {
    tempoNotifyTick().catch((err) =>
      console.warn("[alarm:notify] failed:", err?.message));
    return;
  }
  if (alarm.name.startsWith(SNOOZE_ALARM_PREFIX)) {
    const eventId = alarm.name.slice(SNOOZE_ALARM_PREFIX.length);
    reprompFromSnooze(eventId).catch((err) =>
      console.warn(`[alarm:snooze:${eventId}] failed:`, err?.message));
    return;
  }
  console.warn("[alarm] unknown alarm name:", alarm.name);
});

// Notification interactions.
chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
  if (!notifId.startsWith(NOTIF_ID_PREFIX)) return;
  const eventId = notifId.slice(NOTIF_ID_PREFIX.length);
  if (btnIdx === 0) {
    launchPendingEvent(eventId).catch((err) =>
      console.warn("[notif:launch] failed:", err?.message));
  } else if (btnIdx === 1) {
    snoozeEvent(eventId).catch((err) =>
      console.warn("[notif:snooze] failed:", err?.message));
  }
});

chrome.notifications.onClicked.addListener((notifId) => {
  if (!notifId.startsWith(NOTIF_ID_PREFIX)) return;
  const eventId = notifId.slice(NOTIF_ID_PREFIX.length);
  launchPendingEvent(eventId).catch((err) =>
    console.warn("[notif:click] failed:", err?.message));
});

chrome.notifications.onClosed.addListener((notifId, byUser) => {
  if (!notifId.startsWith(NOTIF_ID_PREFIX)) return;
  // Programmatic clears (Launch / Snooze) already cleaned pending; only handle
  // user dismissals to avoid racing with the launcher.
  if (!byUser) return;
  const eventId = notifId.slice(NOTIF_ID_PREFIX.length);
  withStorageLock("__pendingNotified", async () => {
    const got = await chrome.storage.local.get(PENDING_KEY);
    const pending = got[PENDING_KEY] || {};
    if (pending[eventId]) {
      delete pending[eventId];
      await chrome.storage.local.set({ [PENDING_KEY]: pending });
    }
  }).catch((err) => console.warn("[notif:closed] failed:", err?.message));
});

// Single onMessage dispatcher.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;

  if (type === "tempo:get-popup-state") {
    getPopupDashboardState()
      .then(async (payload) => {
        await syncIconToState().catch(() => {});
        sendResponse({ ok: true, ...payload });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (type === "tempo:authenticate") {
    getAuthToken({ interactive: true })
      .then(() => getPopupDashboardState())
      .then(async (payload) => {
        await syncIconToState().catch(() => {});
        sendResponse({ ok: true, ...payload });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (type === "tempo:mark-launched") {
    const { eventId, endMs } = message;
    updateStorageKey(LAUNCHED_KEY, () => ({ eventId, end: endMs }))
      .then(() => setIconColorSafe("green"))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (type === "tempo:get-current-user") {
    chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }, (info) => {
      sendResponse({ ok: true, email: info?.email || null });
    });
    return true;
  }

  if (type === "tempo:sign-out") {
    signOut()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (type === "tempo:refresh-popup-status") {
    fetchUpcomingEvents({ interactive: false })
      .then((events) => {
        const currentEvent = findCurrentlyActiveEvent(events) || findNextUpcomingEvent(events);
        return writePopupStatus(currentEvent).then(() => ({
          title: currentEvent?.summary || null,
          keywords: extractKeywords(currentEvent?.summary || ""),
        }));
      })
      .then((payload) => sendResponse({ ok: true, ...payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (type === "tempo:launch-event") {
    launchEventNow(message.eventId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (type === "tempo:snooze-event") {
    snoozeEvent(message.eventId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

// ════════════════════════════════════════════════════════════════════════
//  TEST EXPORTS — for manual verification in the SW DevTools console.
// ════════════════════════════════════════════════════════════════════════

self.setIconColor               = setIconColor;
self.getAuthToken               = getAuthToken;
self.fetchUpcomingEvents        = fetchUpcomingEvents;
self.findCurrentlyActiveEvent   = findCurrentlyActiveEvent;
self.findNextUpcomingEvent      = findNextUpcomingEvent;
self.extractKeywords            = extractKeywords;
self.recordTabsForActiveEvent   = recordTabsForActiveEvent;
self.tempoNotifyTick            = tempoNotifyTick;
self.launchPendingEvent         = launchPendingEvent;
self.launchEventNow             = launchEventNow;
self.snoozeEvent                = snoozeEvent;
self.categorizeEvent            = categorizeEvent;
self.learnFromHistory           = learnFromHistory;
self.getOrCacheCategory         = getOrCacheCategory;
self.predictUrlsForCategory     = predictUrlsForCategory;
self.predictLaunchUrlsForEvent  = predictLaunchUrlsForEvent;
self.processFinishedEvent       = processFinishedEvent;
self.detectAndProcessEndedEvent = detectAndProcessEndedEvent;
self.getPopupDashboardState     = getPopupDashboardState;
self.signOut                    = signOut;
self.withStorageLock            = withStorageLock;
self.updateStorageKey           = updateStorageKey;
