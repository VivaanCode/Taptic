const DEFAULTS = {
  username: "",
  team: "",
  token: "",
  serverUrl: "https://taptic.live"
};

const $username = document.getElementById("username");
const $team = document.getElementById("team");
const $token = document.getElementById("token");
const $serverUrl = document.getElementById("serverUrl");
const $status = document.getElementById("status");

function load() {
  chrome.storage.sync.get(DEFAULTS, (s) => {
    const params = new URLSearchParams(window.location.search);
    
    $username.value = params.get("username") || s.username;
    $team.value = params.get("team") || s.team;
    $token.value = params.get("token") || s.token;
    $serverUrl.value = params.get("serverUrl") || s.serverUrl;
    
    if (params.has("username") || params.has("team") || params.has("token") || params.has("serverUrl")) {
      // Auto-save if settings were passed via URL
      save();
      
      // Clean up the URL so a refresh doesn't re-trigger it
      const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
      window.history.replaceState({ path: cleanUrl }, '', cleanUrl);
    }
  });
}

function save() {
  const settings = {
    username: $username.value.trim(),
    team: $team.value.trim(),
    token: $token.value.trim(),
    serverUrl: $serverUrl.value.trim() || DEFAULTS.serverUrl
  };

  if (!settings.username || !settings.team || !settings.token) {
    $status.textContent = "Username, team, and token are all required.";
    $status.className = "status err";
    return;
  }

  chrome.storage.sync.set(settings, () => {
    $status.textContent = "Saved! Reload any open Google Docs tabs for changes to take effect.";
    $status.className = "status ok";
    chrome.runtime.sendMessage({ type: "settings-updated" }, () => {
      let e = chrome.runtime.lastError;
    });
    setTimeout(() => { $status.className = "status"; }, 4000);
  });
}

document.getElementById("saveBtn").addEventListener("click", save);
document.getElementById("resetBtn").addEventListener("click", () => {
  chrome.storage.sync.set(DEFAULTS, () => { load(); });
});

document.getElementById("forceTabsBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "force-send-tabs" }, (response) => {
    if (response && response.ok) {
      $status.textContent = "Tab data sent to server!";
      $status.className = "status ok";
      setTimeout(() => { $status.className = "status"; }, 3000);
    } else {
      $status.textContent = "Failed to send tab data.";
      $status.className = "status err";
      setTimeout(() => { $status.className = "status"; }, 3000);
    }
  });
});

load();
