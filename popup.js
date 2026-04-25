const authPanel = document.getElementById("auth-panel");
const dashboardPanel = document.getElementById("dashboard-panel");
const signInButton = document.getElementById("sign-in-button");
const errorText = document.getElementById("error-text");
const eventTitle = document.getElementById("event-title");
const keywordList = document.getElementById("keyword-list");
const emptyCopy = document.getElementById("empty-copy");

const POPUP_STATUS_KEY = "popupStatus";

function renderKeywords(keywords) {
  keywordList.textContent = "";
  const hasKeywords = keywords.length > 0;
  emptyCopy.hidden = hasKeywords;

  for (const keyword of keywords) {
    const chip = document.createElement("span");
    chip.className = "keyword-chip";
    chip.textContent = keyword;
    keywordList.append(chip);
  }
}

function showAuth(errorMessage = "") {
  authPanel.hidden = false;
  dashboardPanel.hidden = true;
  errorText.hidden = !errorMessage;
  errorText.textContent = errorMessage;
}

function showDashboard(status) {
  authPanel.hidden = true;
  dashboardPanel.hidden = false;
  errorText.hidden = true;
  eventTitle.textContent = status.title || "No current calendar event";
  renderKeywords(status.keywords || []);
}

function getAuthToken(interactive) {
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

function getLocal(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, resolve);
  });
}

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

async function refreshStatusFromBackground() {
  const response = await sendMessage({ type: "tempo:refresh-popup-status" });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not refresh popup status.");
  }
  const stored = await getLocal(POPUP_STATUS_KEY);
  return stored[POPUP_STATUS_KEY] || { title: null, keywords: [] };
}

async function loadPopupState() {
  try {
    await getAuthToken(false);
    const stored = await getLocal(POPUP_STATUS_KEY);
    let status = stored[POPUP_STATUS_KEY];

    if (!status) {
      status = await refreshStatusFromBackground();
    }

    showDashboard(status);
  } catch {
    showAuth();
  }
}

async function handleSignIn() {
  errorText.hidden = true;
  signInButton.disabled = true;
  signInButton.textContent = "Signing in...";

  try {
    await getAuthToken(true);
    const status = await refreshStatusFromBackground();
    showDashboard(status);
  } catch (error) {
    showAuth(error.message);
  } finally {
    signInButton.disabled = false;
    signInButton.textContent = "Sign in with Google";
  }
}

signInButton.addEventListener("click", handleSignIn);

loadPopupState();
