// Tempo popup — Aurora variant. Renders login / dashboard with idle / ready / active totem.

const $ = (id) => document.getElementById(id);

const screens = {
  login: $("screen-login"),
  dashboard: $("screen-dashboard"),
};
const signInButton = $("sign-in-button");
const signinIcon = $("signin-icon");
const signinLabel = $("signin-label");
const errorText = $("error-text");

const greeting = $("greeting");
const headerPill = $("header-pill");
const heroPill = $("hero-pill");
const accountBtn = $("account-btn");
const accountInitials = $("account-initials");
const accountAvatarLg = $("account-avatar-lg");
const accountName = $("account-name");
const accountEmail = $("account-email");
const accountMenu = $("account-menu");
const signOutBtn = $("signout-btn");
const heroTotemEl = $("hero-totem");
const loginTotemEl = $("login-totem");
const heroEyebrow = $("hero-eyebrow");
const heroTitle = $("hero-title");
const heroTime = $("hero-time");
const heroTimeText = $("hero-time-text");
const heroMeet = $("hero-meet");
const launchBtn = $("launch-btn");
const snoozeBtn = $("snooze-btn");
const upnextEmpty = $("upnext-empty");
const upnextRows = $("upnext-rows");
const upnextDate = $("upnext-date");
const footerDot = $("footer-dot");
const footerText = $("footer-text");
const footerClock = $("footer-clock");

const tabBar = $("tab-bar");
const paneToday = $("pane-today");
const paneTasks = $("pane-tasks");

const tasksOpenRows = $("tasks-open-rows");
const tasksDoneRows = $("tasks-done-rows");
const tasksOpenCount = $("tasks-open-count");
const tasksDoneSection = $("tasks-done-section");

let currentEvent = null;
let observedUrls = [];
let currentLaunchUrls = [];

// ── Totem SVG renderer ──────────────────────────────────────────────────
function totemSvg(state) {
  const showZ = state === "idle";
  const showBand = state === "active";
  const eyesClosed = state === "idle";
  const body = `<path d="M50 6 C 26 6, 14 30, 14 60 C 14 84, 28 96, 50 96 C 72 96, 86 84, 86 60 C 86 30, 74 6, 50 6 Z" fill="var(--totem-body)" />`;
  const band = showBand
    ? `<path d="M16 36 Q50 26, 84 36 L84 44 Q50 34, 16 44 Z" fill="#0E7C3A" opacity="0.95" />`
    : "";
  const eyes = eyesClosed
    ? `<path d="M36 58 Q41 63, 46 58" stroke="var(--totem-eye)" stroke-width="2.6" fill="none" stroke-linecap="round" />
       <path d="M54 58 Q59 63, 64 58" stroke="var(--totem-eye)" stroke-width="2.6" fill="none" stroke-linecap="round" />`
    : `<ellipse cx="40" cy="56" rx="3" ry="3.6" fill="var(--totem-eye)" />
       <ellipse cx="60" cy="56" rx="3" ry="3.6" fill="var(--totem-eye)" />`;
  const cheeks = showBand
    ? `<circle cx="26" cy="68" r="3.5" fill="#A7E9BC" opacity="0.85" />
       <circle cx="74" cy="68" r="3.5" fill="#A7E9BC" opacity="0.85" />`
    : "";
  const aura = `<div class="aura"></div>`;
  const zs = showZ
    ? `<div class="totem-zs"><span>Z</span><span>z</span><span>z</span></div>`
    : "";
  return `${aura}<svg viewBox="0 0 100 108" width="72%" height="78%" style="overflow:visible">
    ${body}${band}${eyes}${cheeks}
  </svg>${zs}`;
}

function renderTotem(el, state) {
  el.innerHTML = totemSvg(state);
}

// ── State helpers ───────────────────────────────────────────────────────
function setState(state) {
  document.body.dataset.state = state;
  renderTotem(loginTotemEl, "ready");
  renderTotem(heroTotemEl, state);
  // pills always read "Ready" per design (color shifts via state)
  for (const pill of [headerPill, heroPill]) {
    pill.querySelector("span:last-child").textContent = "Ready";
  }
  footerText.textContent = `${stateLabel(state)} · syncing calendar`;
}

function stateLabel(state) {
  if (state === "idle") return "Idle";
  if (state === "active") return "Active";
  return "Ready";
}

function showScreen(name) {
  document.body.dataset.screen = name;
  screens.login.hidden = name !== "login";
  screens.dashboard.hidden = name !== "dashboard";
}

function showError(message) {
  if (!message) {
    errorText.hidden = true;
    errorText.textContent = "";
    return;
  }
  errorText.hidden = false;
  errorText.textContent = message;
}

function setSignInLoading(loading) {
  signInButton.disabled = loading;
  if (loading) {
    signinIcon.className = "signin-icon is-loading";
    signinIcon.innerHTML = "";
    signinLabel.textContent = "Connecting to Google…";
  } else {
    signinIcon.className = "signin-icon";
    signinIcon.innerHTML = googleGSvg();
    signinLabel.textContent = "Continue with Google";
  }
}

function googleGSvg() {
  return `<svg width="18" height="18" viewBox="0 0 48 48">
    <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>
    <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>
    <path fill="#FBBC05" d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/>
    <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>
  </svg>`;
}

// ── Time / date formatting ──────────────────────────────────────────────
function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(" ", "");
}
function fmtClock() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtFullDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function timeOfDayGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// ── Messaging ───────────────────────────────────────────────────────────
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

// ── Dashboard rendering ─────────────────────────────────────────────────
function deriveState(payload) {
  if (!payload?.authenticated) return "idle";
  const ev = payload.currentEvent;
  if (!ev) return "idle";
  const now = Date.now();
  if (now >= ev.startMs && now < ev.endMs) return "active";
  if (ev.startMs > now && ev.startMs - now <= 60 * 60 * 1000) return "ready";
  return "idle";
}

function renderHero(payload) {
  currentEvent = payload?.currentEvent || null;
  currentLaunchUrls = payload?.currentLaunchUrls || [];
  if (!currentEvent) {
    heroEyebrow.textContent = "All clear";
    heroTitle.textContent = "No upcoming event";
    heroTime.hidden = true;
    heroMeet.hidden = true;
    launchBtn.disabled = true;
    snoozeBtn.disabled = true;
    return;
  }
  const now = Date.now();
  const minsToStart = Math.max(0, Math.round((currentEvent.startMs - now) / 60000));
  const live = now >= currentEvent.startMs && now < currentEvent.endMs;
  heroEyebrow.textContent = live
    ? "Happening now"
    : minsToStart === 0
    ? "Starting now"
    : `Next up · in ${minsToStart} min`;
  heroTitle.textContent = currentEvent.summary || "Untitled event";
  heroTime.hidden = false;
  heroTimeText.textContent = `${fmtTime(currentEvent.startMs)} – ${fmtTime(currentEvent.endMs)}`;
  heroMeet.hidden = !currentEvent.hangoutLink;
  launchBtn.disabled = currentLaunchUrls.length === 0;
  snoozeBtn.disabled = Date.now() >= currentEvent.startMs;
}

function renderUpnext(payload) {
  const events = payload?.upcomingEvents || [];
  upnextRows.replaceChildren();
  if (events.length === 0) {
    upnextEmpty.hidden = false;
    upnextDate.textContent = fmtFullDate(Date.now());
    return;
  }
  upnextEmpty.hidden = true;
  upnextDate.textContent = fmtFullDate(events[0].startMs);
  for (const ev of events) {
    const row = document.createElement("div");
    row.className = "upnext-row";
    const time = document.createElement("div");
    time.className = "upnext-time";
    time.textContent = fmtTime(ev.startMs);
    const title = document.createElement("div");
    title.className = "upnext-title";
    title.textContent = ev.summary || "Untitled";
    row.append(time, title);
    if (ev.hangoutLink) {
      const meet = document.createElement("span");
      meet.className = "upnext-meet";
      meet.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M22 8l-6 4 6 4V8z"/></svg>`;
      row.append(meet);
    }
    upnextRows.append(row);
  }
}

function renderDashboard(payload) {
  observedUrls = (payload?.observedUrls || []).map((u) => u.url || u);
  greeting.textContent = timeOfDayGreeting();
  renderHero(payload);
  renderUpnext(payload);
  setState(deriveState(payload));
  loadCurrentUser();
}

// ── Tasks (local-only, sample data per design) ──────────────────────────
const SAMPLE_TASKS = [
  { id: 1, text: "Review onboarding copy", due: "Today", done: false },
  { id: 2, text: "Ship totem state animations", due: "Today", done: false },
  { id: 3, text: "Reply to Linus re: pricing", due: "Tomorrow", done: false },
  { id: 4, text: "Stand-up notes", due: "Done · 8:55", done: true },
];
let tasks = SAMPLE_TASKS.map((t) => ({ ...t }));

function renderTasks() {
  tasksOpenRows.replaceChildren();
  tasksDoneRows.replaceChildren();
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  tasksOpenCount.textContent = String(open.length);
  tasksDoneSection.hidden = done.length === 0;

  for (const t of open) tasksOpenRows.append(taskRow(t));
  for (const t of done) tasksDoneRows.append(taskRow(t));
}

function taskRow(t) {
  const row = document.createElement("div");
  row.className = "task-row" + (t.done ? " is-done" : "");
  const cb = document.createElement("button");
  cb.type = "button";
  cb.className = "task-checkbox" + (t.done ? " is-done" : "");
  if (t.done) {
    cb.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
  }
  cb.addEventListener("click", () => {
    t.done = !t.done;
    renderTasks();
  });
  const text = document.createElement("div");
  text.className = "task-text";
  text.textContent = t.text;
  const due = document.createElement("div");
  due.className = "task-due";
  due.textContent = t.due;
  row.append(cb, text, due);
  return row;
}

// ── Tab switching ───────────────────────────────────────────────────────
tabBar.addEventListener("click", (e) => {
  const target = e.target.closest("[data-tab]");
  if (!target) return;
  for (const tab of tabBar.querySelectorAll(".tab")) {
    tab.classList.toggle("is-active", tab === target);
  }
  const which = target.dataset.tab;
  paneToday.hidden = which !== "today";
  paneTasks.hidden = which !== "tasks";
  if (which === "tasks") renderTasks();
});

// ── Sign-in ─────────────────────────────────────────────────────────────
async function handleSignIn() {
  showError("");
  setSignInLoading(true);
  try {
    const response = await sendMessage({ type: "tempo:authenticate" });
    if (!response?.ok) throw new Error(response?.error || "Sign-in failed.");
    showScreen("dashboard");
    renderDashboard(response);
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    setSignInLoading(false);
  }
}

signInButton.addEventListener("click", handleSignIn);

// ── Launch ──────────────────────────────────────────────────────────────
launchBtn.addEventListener("click", async () => {
  if (!currentEvent?.id) return;
  try {
    const response = await sendMessage({ type: "tempo:launch-event", eventId: currentEvent.id });
    if (!response?.ok) throw new Error(response?.error || "Launch failed.");
    setState("active");
    window.close();
  } catch (err) {
    showError(err.message || String(err));
  }
  if (!currentEvent && observedUrls.length === 0) return;
  const urls = [];
  if (currentEvent?.hangoutLink) urls.push(currentEvent.hangoutLink);
  for (const u of observedUrls) {
    if (!urls.includes(u)) urls.push(u);
  }
  if (urls.length === 0) return;
  let focused = false;
  for (const url of urls) {
    await chrome.tabs.create({ url, active: !focused });
    focused = true;
  }
  if (currentEvent?.id && currentEvent?.endMs) {
    sendMessage({
      type: "tempo:mark-launched",
      eventId: currentEvent.id,
      endMs: currentEvent.endMs,
    }).catch(() => {});
  }
  setState("active");
  window.close();
});

// ── Snooze ──────────────────────────────────────────────────────────────
snoozeBtn.addEventListener("click", async () => {
  if (!currentEvent?.id) return;
  try {
    const response = await sendMessage({ type: "tempo:snooze-event", eventId: currentEvent.id });
    if (!response?.ok) throw new Error(response?.error || "Snooze failed.");
    window.close();
  } catch (err) {
    showError(err.message || String(err));
  }
});

// ── Account menu + sign-out ─────────────────────────────────────────────
function deriveInitials(email) {
  if (!email) return "··";
  const [local, domain] = email.split("@");
  const a = (local || "").charAt(0).toUpperCase() || "·";
  const b = (domain || "").charAt(0).toUpperCase() || "·";
  return a + b;
}

async function loadCurrentUser() {
  try {
    const res = await sendMessage({ type: "tempo:get-current-user" });
    const email = res?.email || "";
    const initials = deriveInitials(email);
    accountInitials.textContent = initials;
    accountAvatarLg.textContent = initials;
    accountEmail.textContent = email || "Connected to Google Calendar";
    accountName.textContent = email ? email.split("@")[0] : "Signed in";
  } catch {
    accountInitials.textContent = "··";
    accountAvatarLg.textContent = "··";
    accountName.textContent = "Signed in";
    accountEmail.textContent = "Connected to Google Calendar";
  }
}

function setMenuOpen(open) {
  accountMenu.hidden = !open;
  accountBtn.setAttribute("aria-expanded", String(open));
}

accountBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenuOpen(accountMenu.hidden);
});

document.addEventListener("mousedown", (e) => {
  if (accountMenu.hidden) return;
  if (!e.target.closest?.("[data-tempo-account]")) setMenuOpen(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !accountMenu.hidden) setMenuOpen(false);
});

signOutBtn.addEventListener("click", async () => {
  signOutBtn.disabled = true;
  try {
    const res = await sendMessage({ type: "tempo:sign-out" });
    if (!res?.ok) throw new Error(res?.error || "Sign-out failed.");
    setMenuOpen(false);
    setState("idle");
    showScreen("login");
    showError("");
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    signOutBtn.disabled = false;
  }
});

// ── Initial load ────────────────────────────────────────────────────────
async function init() {
  setSignInLoading(false);
  renderTotem(loginTotemEl, "ready");
  renderTotem(heroTotemEl, "ready");
  footerClock.textContent = fmtClock();

  try {
    const response = await sendMessage({ type: "tempo:get-popup-state" });
    if (!response?.ok || !response.authenticated) {
      showScreen("login");
      return;
    }
    showScreen("dashboard");
    renderDashboard(response);
  } catch {
    showScreen("login");
  }
}

init();
