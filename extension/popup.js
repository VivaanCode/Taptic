const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const socketId = document.getElementById("socketId");
const credsCard = document.getElementById("credsCard");

function refresh() {
  chrome.runtime.sendMessage({ type: "get-connection-status" }, (r) => {
    if (chrome.runtime.lastError) return;
    if (r && r.connectionStatus === "connected") {
      dot.className = "dot ok";
      statusText.textContent = "Connected";
      socketId.textContent = r.socketId || "";
    } else {
      dot.className = "dot err";
      statusText.textContent = "Disconnected";
      socketId.textContent = "";
    }
  });

  chrome.storage.sync.get({ username: "", team: "", token: "" }, (s) => {
    if (s.username && s.team && s.token) {
      credsCard.innerHTML =
        `<div class="cred"><b>User:</b> ${s.username}</div>` +
        `<div class="cred"><b>Team:</b> ${s.team}</div>` +
        `<div class="cred"><b>Token:</b> ${s.token.slice(0, 8)}...</div>` +
        `<div class="note">Dashboard metrics are shown as words/min where possible.</div>`;
    } else {
      credsCard.innerHTML = `<p class="warn">No credentials set. Click Settings below to add your username, team, and secret token.</p>`;
    }
  });
}

document.getElementById("settingsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refresh();
setInterval(refresh, 3000);
