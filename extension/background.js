// Background transport and per-tab progress aggregation.
let socket = null;
let serverUrl = "https://demo.vivaan.dev";
const pendingEvents = [];
const tabState = new Map();

importScripts("socket.io.min.js");

function getDefaultState() {
  return {
    docName: "Untitled",
    lastHeartbeatStatus: "waiting",
    visible: {
      charactersAdded: 0,
      charactersRemoved: 0,
      charactersModified: 0,
      activityEvents: 0
    },
    pending: {
      charactersAdded: 0,
      charactersRemoved: 0,
      charactersModified: 0,
      activityEvents: 0
    },
    lastSeenAt: Date.now()
  };
}

function getState(tabId) {
  if (!tabState.has(tabId)) {
    tabState.set(tabId, getDefaultState());
  }
  return tabState.get(tabId);
}

function normalizeDocName(name) {
  const value = String(name || "").trim();
  if (!value) return "";
  if (/^Google Docs$/i.test(value)) return "";
  if (/^Untitled$/i.test(value)) return "";
  if (/^Untitled document$/i.test(value)) return "";
  return value;
}

function loadSettings(callback) {
  chrome.storage.sync.get(
    { username: "", team: "", token: "", serverUrl: "https://demo.vivaan.dev" },
    callback
  );
}

function connectSocket() {
  if (socket && socket.connected) return;

  if (socket) {
    try {
      socket.disconnect();
    } catch (_) {}
    socket = null;
  }

  socket = io(serverUrl, {
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: Infinity,
    transports: ["websocket", "polling"]
  });

  socket.on("connect", () => {
    while (pendingEvents.length > 0) {
      const queued = pendingEvents.shift();
      socket.emit(queued.event, queued.payload);
    }
  });

  socket.on("getScreenshot", () => {
    chrome.tabs.query({ url: "*://docs.google.com/*" }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: "trigger-screenshot" });
      }
    });
  });

  socket.on("disconnect", () => {});
  socket.on("connect_error", () => {});
}

function emitOrQueue(event, payload) {
  connectSocket();
  if (socket && socket.connected) {
    socket.emit(event, payload);
    return true;
  }

  if (pendingEvents.length > 300) pendingEvents.shift();
  pendingEvents.push({ event, payload });
  return false;
}

loadSettings((settings) => {
  serverUrl = settings.serverUrl || "https://demo.vivaan.dev";
  connectSocket();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : null;

  if (msg.type === "activity-delta" && tabId !== null && msg.delta) {
    const state = getState(tabId);
    const delta = msg.delta;

    state.visible.charactersAdded += delta.added || 0;
    state.visible.charactersRemoved += delta.removed || 0;
    state.visible.charactersModified += delta.modified || 0;
    state.visible.activityEvents += delta.events || 0;

    state.pending.charactersAdded += delta.added || 0;
    state.pending.charactersRemoved += delta.removed || 0;
    state.pending.charactersModified += delta.modified || 0;
    state.pending.activityEvents += delta.events || 0;

    const name = normalizeDocName(msg.docName);
    if (name) state.docName = name;
    if (msg.url) state.url = msg.url;
    state.lastSeenAt = Date.now();

    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "doc-meta" && tabId !== null) {
    const state = getState(tabId);
    const name = normalizeDocName(msg.docName);
    if (name) state.docName = name;
    if (msg.url) state.url = msg.url;
    state.lastSeenAt = Date.now();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "get-tracking-state" && tabId !== null) {
    const state = getState(tabId);
    sendResponse({
      visible: state.visible,
      docName: state.docName,
      lastHeartbeatStatus: state.lastHeartbeatStatus,
      connectionStatus: socket && socket.connected ? "connected" : "disconnected"
    });
    return false;
  }

  if (msg.type === "flush-heartbeat" && tabId !== null) {
    const state = getState(tabId);
    loadSettings((settings) => {
      if (!settings.username || !settings.team || !settings.token) {
        state.lastHeartbeatStatus = "missing credentials";
        sendResponse({ ok: false, error: "missing credentials" });
        return;
      }

      let serviceName = "seam_tracker";
      try {
        if (state.url) {
          serviceName = new URL(state.url).hostname.replace(/^www\./, "");
        }
      } catch (e) {}

      const payload = {
        username: settings.username,
        team: settings.team,
        token: settings.token,
        charactersAdded: state.pending.charactersAdded,
        charactersRemoved: state.pending.charactersRemoved,
        charactersModified: state.pending.charactersModified,
        service: serviceName,
        document_name: state.docName || "Untitled"
      };

      const sentNow = emitOrQueue("heartbeat", payload);
      state.lastHeartbeatStatus = sentNow ? "sent" : "queued";
      state.pending = {
        charactersAdded: 0,
        charactersRemoved: 0,
        charactersModified: 0,
        activityEvents: 0
      };

      sendResponse({ ok: true, sentNow, payload });
    });
    return true;
  }

  if (msg.type === "take-screenshot") {
    const winId = sender.tab ? sender.tab.windowId : null;
    if (!winId) {
      sendResponse({ ok: false, error: "no window" });
      return false;
    }

    loadSettings((settings) => {
      chrome.tabs.captureVisibleTab(winId, { format: "png" }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }

        fetch(dataUrl)
          .then(res => res.blob())
          .then(blob => {
            const formData = new FormData();
            formData.append("reqtype", "fileupload");
            formData.append("time", "1h");
            formData.append("fileToUpload", blob, "screenshot.png");
            
            return fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
              method: "POST",
              body: formData
            });
          })
          .then(response => response.text())
          .then((litterboxUrl) => {
            let serviceName = "seam_tracker";
            try {
              if (sender.tab && sender.tab.url) {
                serviceName = new URL(sender.tab.url).hostname.replace(/^www\./, "");
              }
            } catch (e) {}

            const payload = {
              type: "screenshot",
              url: litterboxUrl.trim(),
              username: settings.username || "",
              team: settings.team || "",
              token: settings.token || "",
              service: serviceName,
              document_name: msg.meta && msg.meta.document_name ? msg.meta.document_name : "",
              timestamp: Date.now()
            };
            const sentNow = emitOrQueue("message", payload);
            sendResponse({ ok: true, sentNow, url: payload.url });
          })
          .catch((error) => {
            sendResponse({ ok: false, error: String(error) });
          });
      });
    });

    return true;
  }

  if (msg.type === "get-connection-status") {
    sendResponse({
      connectionStatus: socket && socket.connected ? "connected" : "disconnected",
      socketId: socket ? socket.id : null
    });
    return false;
  }

  if (msg.type === "settings-updated") {
    loadSettings((settings) => {
      const newUrl = settings.serverUrl || "https://demo.vivaan.dev";
      if (newUrl !== serverUrl) {
        serverUrl = newUrl;
        if (socket) {
          try {
            socket.disconnect();
          } catch (_) {}
          socket = null;
        }
        connectSocket();
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  connectSocket();
});
