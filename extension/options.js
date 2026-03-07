const DEFAULTS = {
  username: "",
  team: "",
  token: "",
  serverUrl: "https://demo.vivaan.dev"
};

const $username = document.getElementById("username");
const $team = document.getElementById("team");
const $token = document.getElementById("token");
const $serverUrl = document.getElementById("serverUrl");
const $status = document.getElementById("status");

function load() {
  chrome.storage.sync.get(DEFAULTS, (s) => {
    $username.value = s.username;
    $team.value = s.team;
    $token.value = s.token;
    $serverUrl.value = s.serverUrl;
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
    chrome.runtime.sendMessage({ type: "settings-updated" }).catch(() => {});
    setTimeout(() => { $status.className = "status"; }, 4000);
  });
}

document.getElementById("saveBtn").addEventListener("click", save);
document.getElementById("resetBtn").addEventListener("click", () => {
  chrome.storage.sync.set(DEFAULTS, () => { load(); });
});

load();
