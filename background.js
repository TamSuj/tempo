console.log("Extension Active");

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
const LAUNCHED_KEY           = "launchedEvent";     // { eventId, start, end }
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
const PREDICTED_TOP_DOMAINS  = 3; // Tier-3 default top-N (e.g., top 3 banking sites)

// Permission descriptors — runtime checks of optional/declared permissions.
const HISTORY_PERMISSION     = { permissions: ["history"] };

const ZOOM_URL_RE = /https:\/\/[\w.-]*zoom\.us\/[^\s<>"')]+/i;
const URL_RE      = /https?:\/\/[^\s<>"')]+/gi;

const STOP_WORDS = new Set([
  "a", "an", "and", "the", "or", "of", "for", "to", "with", "in", "on", "at",
  "by", "from", "is", "are", "be", "as", "vs", "via",
  "meeting", "meet", "sync", "syncs", "call", "calls", "chat", "standup",
  "stand-up", "1on1", "1-on-1", "1:1", "weekly", "daily", "monthly", "review",
  "check-in", "checkin", "catchup", "catch-up", "discussion", "discuss",
]);

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

// Lock-safe single-key reader. Ensures predictive lookups can't race a
// concurrent learnFromHistory write into the same bucket.
async function readStorageKey(key) {
  return withStorageLock(key, async () => {
    const got = await chrome.storage.local.get(key);
    return got[key];
  });
}

// ════════════════════════════════════════════════════════════════════════
//  PERMISSIONS  — runtime checks for declared/optional permissions.
//  History prediction (Tier 3) is gated on the user actually having
//  granted the "history" permission at runtime; presence in the manifest
//  is necessary but not sufficient under MV3.
// ════════════════════════════════════════════════════════════════════════

async function hasHistoryPermission() {
  try {
    if (!chrome?.permissions?.contains) return false;
    return await new Promise((resolve) => {
      chrome.permissions.contains(HISTORY_PERMISSION, (granted) => {
        if (chrome.runtime.lastError) {
          console.warn("[permissions] contains(history) error:",
            chrome.runtime.lastError.message);
          resolve(false);
          return;
        }
        resolve(Boolean(granted));
      });
    });
  } catch (err) {
    console.warn("[permissions] hasHistoryPermission failed:", err?.message);
    return false;
  }
}

// One-shot startup log so the user sees the gate in the SW console.
async function logHistoryPermissionGate() {
  const granted = await hasHistoryPermission();
  if (granted) {
    console.log("[permissions] history: granted — predictive Tier 3 enabled");
  } else {
    console.warn(
      "[permissions] history: NOT granted — predictive Tier 3 disabled. " +
      "Events without explicit URLs will use Tier 1/2 only."
    );
  }
  return granted;
}

// ════════════════════════════════════════════════════════════════════════
//  PURE HELPERS  — no chrome.* state, no I/O.
// ════════════════════════════════════════════════════════════════════════

function isNoiseUrl(url) {
  if (!url) return true;
  return HISTORY_NOISE_PATTERNS.some((re) => re.test(url));
}

function domainFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "www.google.com" && parsed.pathname === "/url") {
      const target = parsed.searchParams.get("q");
      if (target) return normalizeUrl(target);
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
    `one-word category (e.g., finance, design, engineering, sync, personal, bills): ` +
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
//  Hard-gated on hasHistoryPermission(): if absent, this is a no-op.
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

  if (!(await hasHistoryPermission())) {
    console.warn("[learnFromHistory] history permission missing — skipping learn");
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
    .slice(0, PREDICTED_TOP_DOMAINS)
    .map(([d]) => d);
}

// ════════════════════════════════════════════════════════════════════════
//  PREDICTIVE PIPELINE
// ════════════════════════════════════════════════════════════════════════

// Cached per event id; cache write is lock-protected.
async function getOrCacheCategory(event) {
  if (!event?.id || !event?.summary) return null;
  const cache = await readStorageKey(CATEGORY_CACHE_KEY);
  const hit = cache?.[event.id];
  if (hit?.category && Number.isFinite(hit.ts)
      && Date.now() - hit.ts < CATEGORY_CACHE_TTL_MS) {
    return hit.category;
  }
  const category = await categorizeEvent(event.summary);
  if (category) {
    await updateStorageKey(CATEGORY_CACHE_KEY, (current) => {
      const next = current || {};
      next[event.id] = { category, ts: Date.now() };
      return next;
    });
  }
  return category;
}

// Tier 3 lookup: top history-scored domains for the given Gemini category.
// Uses a lock-safe read so concurrent learnFromHistory writes can't race.
async function predictUrlsForCategory(category, limit = PREDICTED_TOP_DOMAINS) {
  if (!category) return [];
  const all = await readStorageKey(CATEGORY_DOMAINS_KEY);
  const bucket = all?.[category];
  if (!bucket) return [];
  return Object.entries(bucket)
    .filter(([, score]) => Number.isFinite(score) && score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([domain]) => `https://${domain}/`);
}

// Three-tier resolver for the "what do I open for this event" question:
//   Tier 1: explicit URLs in the event (hangoutLink, location, description, attachments).
//   Tier 2: keyword-ranked URLs from observed-tab learning.
//   Tier 3: Gemini category → top history-scored domains (requires history perm).
//
// Tier 3 is gated on the user having granted the "history" permission at
// runtime. If history is unavailable, we degrade gracefully to [] rather
// than throwing — the caller (launchEventNow / tempoNotifyTick) decides
// what to do when no URLs at all can be resolved.
async function predictLaunchUrlsForEvent(event, keywordMap) {
  // Tier 1: explicit URLs — meeting link / hangoutLink wins.
  const explicit = extractUrlsFromEvent(event);
  if (explicit.length > 0) {
    return explicit.slice(0, LAUNCH_MAX_TABS);
  }

  // Tier 2: keyword-ranked URL list from observed-tab learning.
  const learned = rankUrlsForKeywords(extractKeywords(event?.summary), keywordMap);
  if (learned.length > 0) {
    return learned.slice(0, LAUNCH_MAX_TABS);
  }

  // Tier 3: Gemini category → top history-scored domains. Permission-gated.
  if (!(await hasHistoryPermission())) {
    console.log(
      `[predict] "${event?.summary}" — Tiers 1/2 empty, Tier 3 unavailable ` +
      `(history permission not granted)`
    );
    return [];
  }

  let category = null;
  try {
    category = await getOrCacheCategory(event);
  } catch (err) {
    console.warn("[predict] getOrCacheCategory failed:", err?.message);
    return [];
  }
  if (!category) {
    console.log(`[predict] "${event?.summary}" — no Gemini category, no Tier 3 fallback`);
    return [];
  }

  let predicted = [];
  try {
    predicted = await predictUrlsForCategory(category);
  } catch (err) {
    console.warn(
      `[predict] predictUrlsForCategory("${category}") failed:`, err?.message
    );
    return [];
  }
  if (predicted.length > 0) {
    console.log(
      `[predict] Tier 3 hit: "${event?.summary}" → category "${category}" → ` +
      `${predicted.length} url(s) [${predicted.join(", ")}]`
    );
  } else {
    console.log(
      `[predict] Tier 3 miss: "${event?.summary}" → category "${category}" → ` +
      `no scored history yet for this category`
    );
  }
  return predicted;
}

// Post-event hook. Idempotent + retry-aware:
//   - never stamps `done` until the learn pipeline succeeds,
//   - tracks an `attempts` counter so transient Gemini/history failures retry,
//   - silently drops permanently malformed events (start/end missing),
//   - skips entirely if history permission is not granted (nothing to learn).
async function processFinishedEvent(eventSummary) {
  if (!eventSummary?.id) return;
  if (!Number.isFinite(eventSummary.startMs)
      || !Number.isFinite(eventSummary.endMs)
      || eventSummary.endMs <= eventSummary.startMs) {
    console.warn("[post-hook] malformed event, skipping", eventSummary?.id);
    return;
  }

  if (!(await hasHistoryPermission())) {
    console.log("[post-hook] history permission missing — skipping learn for",
      eventSummary.id);
    return;
  }

  const processed = await readStorageKey(PROCESSED_EVENTS_KEY);
  const current = processed?.[eventSummary.id];
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
  const lastActive = await readStorageKey(LAST_ACTIVE_KEY);
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

  // Tier 2 quality gate: drop noisy URLs (mail/calendar/search/chrome://, etc.)
  // BEFORE they ever enter the keyword bucket. Same isNoiseUrl filter used by
  // Tier 3 / learnFromHistory, so both pipelines apply identical noise rules.
  const rawUrls = await getActiveWindowTabUrls();
  const urls = [...new Set(
    rawUrls
      .map(normalizeUrl)
      .filter((u) => u && !isNoiseUrl(u))
  )];
  const droppedCount = rawUrls.length - urls.length;
  if (urls.length === 0) {
    if (droppedCount > 0) {
      console.log(
        `[learn] "${ev.summary}" → all ${droppedCount} tab(s) filtered as noise; nothing learned`
      );
    }
    return;
  }

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
    `[learn] "${ev.summary}" → keywords [${keywords.join(", ")}], +${urls.length} tab(s)` +
    (droppedCount > 0 ? ` (filtered ${droppedCount} noise URL(s))` : "")
  );
}

// ════════════════════════════════════════════════════════════════════════
//  NOTIFICATION + LAUNCH FLOW
// ════════════════════════════════════════════════════════════════════════

async function promptForEvent(event, urls) {
  const eventId = event.id;
  const start = eventStartMs(event);
  const end = eventEndMs(event);

  // Single locked transaction over both keys.
  await withStorageLock("__pendingNotified", async () => {
    const got = await chrome.storage.local.get([PENDING_KEY, NOTIFIED_KEY]);
    const pending = got[PENDING_KEY] || {};
    const notified = got[NOTIFIED_KEY] || {};
    pending[eventId] = { urls, start, end };
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

  await updateStorageKey(LAUNCHED_KEY, () => ({ eventId, start: entry.start, end: entry.end }));
  await syncIconToState().catch((err) =>
    console.warn("[launch] syncIconToState failed:", err?.message)
  );
  await chrome.notifications.clear(NOTIF_ID_PREFIX + eventId).catch(() => {});
  console.log(`[launch] opened ${openedCount} tab(s) for ${eventId}`);
}

// User-initiated launch from the popup. Resolves URLs through the full
// three-tier pipeline so events without explicit URLs no longer dead-end:
// they fall through to keyword-learning (Tier 2) and Gemini+history (Tier 3).
async function launchEventNow(eventId) {
  const event = await findEventById(eventId);
  if (!event) throw new Error(`Tempo could not find event ${eventId}.`);

  const stored = (await readStorageKey(STORAGE_KEY)) || {};
  const urls = await predictLaunchUrlsForEvent(event, stored);

  if (urls.length === 0) {
    // Surface a permission-aware error so the UI/user can act on it.
    const historyOk = await hasHistoryPermission();
    if (!historyOk) {
      throw new Error(
        "No launchable URLs. Grant the 'history' permission to enable " +
        "predictive workspace suggestions for events without explicit links."
      );
    }
    throw new Error(
      "No launchable URLs yet — Tempo needs more history to predict " +
      "this event's workspace. It will keep learning."
    );
  }

  await withStorageLock("__pendingNotified", async () => {
    const cur = await chrome.storage.local.get(PENDING_KEY);
    const pending = cur[PENDING_KEY] || {};
    pending[eventId] = { urls, start: eventStartMs(event), end: eventEndMs(event) };
    await chrome.storage.local.set({ [PENDING_KEY]: pending });
  });
  await launchPendingEvent(eventId);
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
  // Map state → toolbar icon. Includes all four sizes Chrome may request
  // for the pinned action button (16/32/48/128).
  const ICON_MAP = {
    idle: {
      16:  "icons/icon-grey-16.png",
      32:  "icons/icon-grey-32.png",
      48:  "icons/icon-grey-48.png",
      128: "icons/icon-grey-128.png",
    },
    ready: {
      16:  "icons/icon-blue-16.png",
      32:  "icons/icon-blue-32.png",
      48:  "icons/icon-blue-48.png",
      128: "icons/icon-blue-128.png",
    },
    active: {
      16:  "icons/icon-green-16.png",
      32:  "icons/icon-green-32.png",
      48:  "icons/icon-green-48.png",
      128: "icons/icon-green-128.png",
    },
  };
  const applyIcon = async (state) => {
    await chrome.action.setIcon({ path: ICON_MAP[state] }).catch((err) =>
      console.warn(`[icon] setIcon(${state}) failed:`, err?.message)
    );
    await chrome.action.setBadgeBackgroundColor({
      color: state === "idle" ? "#9CA3AF" : state === "active" ? "#2DBE5A" : "#2F8BF6",
    }).catch((err) =>
      console.warn("[icon] failed to set badge background color:", err?.message)
    );
    if (state === "idle") {
      await chrome.action.setIcon({ path: ICON_MAP.idle }).catch((err) =>
        console.warn("[icon] explicit idle reset failed:", err?.message)
      );
      await chrome.action.setBadgeText({ text: "" }).catch((err) =>
        console.warn("[icon] failed to clear badge text:", err?.message)
      );
    } else if (state === "ready") {
      await chrome.action.setBadgeText({ text: "READY" }).catch((err) =>
        console.warn("[icon] failed to set READY badge text:", err?.message)
      );
    } else {
      await chrome.action.setBadgeText({ text: "LIVE" }).catch((err) =>
        console.warn("[icon] failed to set LIVE badge text:", err?.message)
      );
    }
  };

  // Stale-LAUNCHED_KEY purge: green icon is gated on a still-running event.
  // If the stored end has passed (or end is missing/malformed), drop the key
  // so the icon can fall through to ready/idle below instead of sticking green.
  const launched = await readStorageKey(LAUNCHED_KEY);
  const now = Date.now();
  const launchedStillActive =
    launched
    && Number.isFinite(launched.start)
    && Number.isFinite(launched.end)
    && launched.start <= now
    && now < launched.end;
  if (launchedStillActive) {
    await applyIcon("active");
    return "active";
  }
  if (launched) {
    // Either expired (Date.now() > end) or malformed (no/NaN end) — clear it.
    await chrome.storage.local.remove(LAUNCHED_KEY).catch((err) =>
      console.warn("[icon] failed to clear stale LAUNCHED_KEY:", err?.message)
    );
    console.log("[icon] cleared stale LAUNCHED_KEY (event ended or malformed)");
  }

  let events;
  try {
    events = await fetchUpcomingEvents({ interactive: false });
  } catch {
    await applyIcon("idle");
    return "idle";
  }

  const liveOrSoon = events.find((e) => {
    const s = eventStartMs(e);
    const en = eventEndMs(e);
    if (Number.isFinite(s) && Number.isFinite(en) && s <= now && now < en) return true;
    if (Number.isFinite(s) && s > now && s - now <= READY_HORIZON_MS) return true;
    return false;
  });
  if (liveOrSoon) {
    await applyIcon("ready");
    return "ready";
  }
  await applyIcon("idle");
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
    // was active and has now ended. Internally permission-gated.
    await detectAndProcessEndedEvent(events).catch((err) =>
      console.warn("[notify] post-hook failed:", err?.message)
    );

    // Pick the imminent event: prefer something starting within the lookahead;
    // otherwise grab whatever is live right now.
    const upcoming = findEventStartingWithin(events, NOTIFY_LOOKAHEAD_MS);
    const ev = upcoming || findCurrentlyActiveEvent(events);
    if (!ev) {
      await chrome.storage.local.set({
        [POPUP_STATUS_KEY]: {
          title: null,
          keywords: [],
          state: "idle",
          updatedAt: Date.now(),
        },
      });
      return;
    }

    // Atomic dedup check + reservation: if not yet notified, we'll prompt.
    const reserved = await withStorageLock("__pendingNotified", async () => {
      const got = await chrome.storage.local.get(NOTIFIED_KEY);
      const notified = got[NOTIFIED_KEY] || {};
      if (notified[ev.id]) return false;
      // Don't stamp here — promptForEvent stamps inside the same lock.
      return true;
    });
    if (!reserved) return;

    // Three-tier predictive resolution. Tier 3 (Gemini + history) kicks in
    // automatically when Tiers 1/2 are empty and history permission exists.
    const stored = (await readStorageKey(STORAGE_KEY)) || {};
    const urls = await predictLaunchUrlsForEvent(ev, stored);
    if (urls.length === 0) {
      console.log(
        `[notify] "${ev.summary}" — no URLs from any tier; skipping prompt`
      );
      return;
    }

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

  const stored = (await readStorageKey(STORAGE_KEY)) || {};
  const urls = await predictLaunchUrlsForEvent(ev, stored);
  if (urls.length === 0) {
    console.log(`[snooze] "${ev.summary}" — no URLs from any tier; skipping reprompt`);
    return;
  }

  await promptForEvent(ev, urls);
}

// ════════════════════════════════════════════════════════════════════════
//  POPUP STATE
// ════════════════════════════════════════════════════════════════════════

async function writePopupStatus(event = null, state = null) {
  const nextState = state || (event ? "ready" : "idle");
  await updateStorageKey(POPUP_STATUS_KEY, () => ({
    title: event?.summary || null,
    keywords: extractKeywords(event?.summary || ""),
    state: nextState,
    updatedAt: Date.now(),
  }));
}

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
      historyPermission: await hasHistoryPermission(),
    };
  }

  try {
    const events = await fetchUpcomingEvents({ interactive: false });

    const liveEvent = findCurrentlyActiveEvent(events);
    const nextEvent = findNextUpcomingEvent(events);
    const isNextWithinReadyWindow =
      Number.isFinite(eventStartMs(nextEvent))
      && eventStartMs(nextEvent) - Date.now() <= NOTIFY_LOOKAHEAD_MS;
    const currentEvent = liveEvent || (isNextWithinReadyWindow ? nextEvent : null);
    const currentKeyword = firstKeywordFromEvent(currentEvent);
    const popupState = liveEvent ? "active" : (currentEvent ? "ready" : "idle");

    await writePopupStatus(currentEvent, popupState);

    const stored = (await readStorageKey(STORAGE_KEY)) || {};

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
      state: popupState,
      currentKeyword,
      observedUrls,
      eventTitle: currentEvent?.summary || null,
      currentEvent: summarizeEvent(currentEvent),
      currentLaunchUrls,
      upcomingEvents,
      tokenPresent: Boolean(token),
      historyPermission: await hasHistoryPermission(),
    };
  } catch (err) {
    console.warn("[popup] failed to build dashboard state:", err.message);
    return {
      authenticated: true,
      state: "idle",
      currentKeyword: null,
      observedUrls: [],
      eventTitle: null,
      currentEvent: null,
      currentLaunchUrls: [],
      upcomingEvents: [],
      tokenPresent: Boolean(token),
      historyPermission: await hasHistoryPermission(),
      error: err.message,
    };
  }
}

// ════════════════════════════════════════════════════════════════════════
//  SIGN-OUT
// ════════════════════════════════════════════════════════════════════════

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

// Initializes the 'Transition to Flow' workflow:
//   1) Resets the icon (on fresh install only).
//   2) Logs the runtime history-permission state so the operator can see
//      whether predictive Tier 3 is live.
//   3) Ensures recurring alarms exist.
//   4) Syncs the icon to current calendar state.
async function masterStartup({ fresh }) {
  if (fresh) {
    await setIconColorSafe("grey");
  }
  await logHistoryPermissionGate().catch(() => {});
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

// Keep the in-process permission gate log in sync if the user toggles
// the history permission at runtime.
if (chrome?.permissions?.onAdded) {
  chrome.permissions.onAdded.addListener((perms) => {
    if (perms?.permissions?.includes("history")) {
      console.log("[permissions] history granted at runtime — Tier 3 now active");
    }
  });
}
if (chrome?.permissions?.onRemoved) {
  chrome.permissions.onRemoved.addListener((perms) => {
    if (perms?.permissions?.includes("history")) {
      console.warn("[permissions] history revoked at runtime — Tier 3 disabled");
    }
  });
}

// Keep toolbar icon in sync on state-bearing storage writes.
if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes[LAUNCHED_KEY] && !changes[PENDING_KEY] && !changes[NOTIFIED_KEY]) return;
    syncIconToState().catch((err) =>
      console.warn("[storage] syncIconToState failed:", err?.message)
    );
  });
}

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
    const { eventId, startMs, endMs } = message;
    updateStorageKey(LAUNCHED_KEY, () => ({ eventId, start: startMs, end: endMs }))
      .then(() => syncIconToState())
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
        const activeEvent = findCurrentlyActiveEvent(events);
        const nextEvent = findNextUpcomingEvent(events);
        const isNextWithinReadyWindow =
          Number.isFinite(eventStartMs(nextEvent))
          && eventStartMs(nextEvent) - Date.now() <= NOTIFY_LOOKAHEAD_MS;
        const currentEvent = activeEvent || (isNextWithinReadyWindow ? nextEvent : null);
        const state = activeEvent ? "active" : (currentEvent ? "ready" : "idle");
        return writePopupStatus(currentEvent, state).then(() => ({
          title: currentEvent?.summary || null,
          keywords: extractKeywords(currentEvent?.summary || ""),
          state,
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

  if (type === "tempo:has-history-permission") {
    hasHistoryPermission()
      .then((granted) => sendResponse({ ok: true, granted }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // Popup-open icon resync: forces syncIconToState so a stale green icon
  // (e.g. left over from a previous active event) is re-evaluated the
  // moment the user opens the popup.
  if (type === "tempo:sync-icon") {
    syncIconToState()
      .then((state) => sendResponse({ ok: true, state }))
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
self.readStorageKey             = readStorageKey;
self.hasHistoryPermission       = hasHistoryPermission;
