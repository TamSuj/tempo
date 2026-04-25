console.log("Extension Active");

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

function getAuthToken({ interactive = true } = {}) {
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

async function fetchUpcomingEvents() {
  const token = await getAuthToken();
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

  const urls = await getActiveWindowTabUrls();
  if (urls.length === 0) return;

  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
  for (const kw of keywords) {
    const bucket = stored[kw] || {};
    for (const url of urls) {
      bucket[url] = (bucket[url] || 0) + 1;
    }
    stored[kw] = bucket;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: stored });

  console.log(
    `Tempo learn: "${ev.summary}" → keywords [${keywords.join(", ")}], recorded ${urls.length} tab(s).`
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
const NOTIFY_LOOKAHEAD_MS = 90 * 1000;
const LAUNCH_FREQ_MIN = 2;
const LAUNCH_MAX_TABS = 8;
const PENDING_KEY = "pendingLaunches";
const NOTIFIED_KEY = "notifiedEventIds";
const LAUNCHED_KEY = "launchedEvent";

function pickEventStartingSoon(events, withinMs) {
  const now = Date.now();
  for (const ev of events) {
    const start = new Date(ev.start?.dateTime || ev.start?.date || 0).getTime();
    if (start > now && start - now <= withinMs) return ev;
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
  const pending = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] || {};
  const entry = pending[eventId];
  if (!entry) {
    console.warn(`Tempo launch: no pending entry for ${eventId}.`);
    return;
  }
  for (const url of entry.urls) {
    chrome.tabs.create({ url, active: false });
  }
  await setIconColor("green");
  delete pending[eventId];
  await chrome.storage.local.set({
    [PENDING_KEY]: pending,
    [LAUNCHED_KEY]: { eventId, end: entry.end },
  });
  chrome.notifications.clear(NOTIF_ID_PREFIX + eventId);
  console.log(`Tempo launch: opened ${entry.urls.length} tab(s) for event ${eventId}.`);
}

async function snoozeEvent(eventId) {
  chrome.notifications.clear(NOTIF_ID_PREFIX + eventId);
  const notified = (await chrome.storage.local.get(NOTIFIED_KEY))[NOTIFIED_KEY] || {};
  delete notified[eventId];
  await chrome.storage.local.set({ [NOTIFIED_KEY]: notified });
  chrome.alarms.create(SNOOZE_ALARM_PREFIX + eventId, { delayInMinutes: SNOOZE_DELAY_MIN });
  console.log(`Tempo snooze: re-prompt for ${eventId} in ${SNOOZE_DELAY_MIN} min.`);
}

async function maybeRevertIcon() {
  const launched = (await chrome.storage.local.get(LAUNCHED_KEY))[LAUNCHED_KEY];
  if (!launched) return;
  if (Date.now() > launched.end) {
    await setIconColor("grey");
    await chrome.storage.local.remove(LAUNCHED_KEY);
  }
}

async function tempoNotifyTick() {
  let events;
  try {
    events = await fetchUpcomingEvents();
  } catch (err) {
    console.warn("Tempo notify: calendar fetch failed:", err.message);
    return;
  }
  await maybeRevertIcon();

  const ev = pickEventStartingSoon(events, NOTIFY_LOOKAHEAD_MS);
  if (!ev) return;

  const notified = (await chrome.storage.local.get(NOTIFIED_KEY))[NOTIFIED_KEY] || {};
  if (notified[ev.id]) return;

  const keywords = extractKeywords(ev.summary);
  if (keywords.length === 0) return;

  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
  const urls = rankUrlsForKeywords(keywords, stored);
  if (urls.length === 0) return;

  await promptForEvent(ev, urls);
}

async function reprompFromSnooze(eventId) {
  let events;
  try {
    events = await fetchUpcomingEvents();
  } catch (err) {
    console.warn("Tempo snooze: calendar fetch failed:", err.message);
    return;
  }
  const ev = events.find((e) => e.id === eventId);
  if (!ev) return;
  if (eventEndMs(ev) <= Date.now()) return;

  const keywords = extractKeywords(ev.summary);
  if (keywords.length === 0) return;
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
  const urls = rankUrlsForKeywords(keywords, stored);
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
  if (btnIdx === 0) launchPendingEvent(eventId);
  else if (btnIdx === 1) snoozeEvent(eventId);
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
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(NOTIFY_ALARM, { periodInMinutes: NOTIFY_PERIOD_MIN });
});

self.tempoNotifyTick = tempoNotifyTick;
self.launchPendingEvent = launchPendingEvent;
self.snoozeEvent = snoozeEvent;
