// Seam — Google Docs progress tracker with in-page overlay
(function () {
  if (window.__seamLoaded) return;
  window.__seamLoaded = true;

  const isTopFrame = window === window.top;

  let lastStructuredInputAt = 0;

  function sendRuntimeMessage(message, callback) {
    try {
      chrome.runtime.sendMessage(message, callback);
    } catch (_) {}
  }

  function getDocName() {
    const hostname = window.location.hostname;

    if (hostname === "github.com") {
      const repoLink = document.querySelector('[itemprop="name"] a') || document.querySelector('meta[property="og:title"]');
      if (repoLink && repoLink.textContent) return `GitHub: ${repoLink.textContent.trim()}`;
      if (repoLink && repoLink.content) return `GitHub: ${repoLink.content.trim()}`;
      return "GitHub";
    }

    if (hostname.includes("replit.com")) {
      return document.title.replace("- Replit", "").trim() || "Replit";
    }

    if (hostname.includes("notion.so")) {
      return document.title.trim() || "Notion";
    }

    if (hostname.includes("docs.google.com")) {
      const titleInner = document.querySelector(".docs-title-inner");
      if (titleInner && titleInner.textContent) {
        const text = titleInner.textContent.trim();
        if (text) return text;
      }

      const titleInput = document.querySelector(".docs-title-input");
      if (titleInput && titleInput.value) {
        const text = titleInput.value.trim();
        if (text) return text;
      }

      const titleMenuButton =
        document.querySelector('[aria-label^="Rename"]') ||
        document.querySelector('[aria-label*="Document title"]');

      if (
        titleMenuButton &&
        titleMenuButton.getAttribute("aria-label") &&
        titleMenuButton.getAttribute("aria-label").trim()
      ) {
        const label = titleMenuButton.getAttribute("aria-label").trim();
        return label.replace(/^Rename\s*/i, "").replace(/Document title\s*/i, "").trim() || "Untitled";
      }
    }

    const raw = document.title || "";
    if (raw) return raw.trim();
    return "Untitled";
  }

  function sendDocMeta() {
    sendRuntimeMessage({
      type: "doc-meta",
      docName: getDocName(),
      url: window.location.href,
      isTopFrame
    });
  }

  function sendDelta(delta) {
    if (!delta) return;
    sendRuntimeMessage({
      type: "activity-delta",
      delta,
      docName: getDocName(),
      url: window.location.href,
      isTopFrame
    });
  }

  function deltaFromBeforeInput(event) {
    const inputType = event.inputType || "";
    const dataLength = typeof event.data === "string" ? event.data.length : 0;
    if (inputType.startsWith("insert")) {
      const added = dataLength || 1;
      return { added, removed: 0, modified: 0, events: 1 };
    }
    if (inputType.startsWith("delete")) {
      const removed = dataLength || 1;
      return { added: 0, removed, modified: 0, events: 1 };
    }
    return null;
  }

  function deltaFromKeydown(event) {
    const key = event.key || "";
    if (key === "Backspace" || key === "Delete") {
      return { added: 0, removed: 1, modified: 0, events: 1 };
    }
    if (key === "Enter") {
      return { added: 1, removed: 0, modified: 0, events: 1 };
    }
    if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      return { added: 1, removed: 0, modified: 0, events: 1 };
    }
    return null;
  }

  function isEditable(target) {
    if (!target) return false;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return true;
    if (target.isContentEditable) return true;
    if (target.ownerDocument && target.ownerDocument.designMode === "on") return true;
    
    if (target.tagName === "BODY" && window.location.hostname.includes("docs.google.com") && window !== window.top) {
      return true;
    }
    
    return false;
  }

  const attachedWindows = new WeakSet();

  function attachActivityListeners(targetWindow) {
    if (attachedWindows.has(targetWindow)) return;
    attachedWindows.add(targetWindow);

    targetWindow.addEventListener("beforeinput", (event) => {
      if (!isEditable(event.target)) return;
      const delta = deltaFromBeforeInput(event);
      if (!delta) return;
      lastStructuredInputAt = Date.now();
      sendDelta(delta);
    }, true);

    targetWindow.addEventListener("input", (event) => {
      if (!isEditable(event.target)) return;
      if (Date.now() - lastStructuredInputAt > 40) {
        lastStructuredInputAt = Date.now();
        sendDelta({ added: 0, removed: 0, modified: 0, events: 1 });
      }
    }, true);

    targetWindow.addEventListener("compositionend", (event) => {
      if (!isEditable(event.target)) return;
      const text = event.data || "";
      if (!text) return;
      lastStructuredInputAt = Date.now();
      sendDelta({ added: text.length, removed: 0, modified: 0, events: 1 });
    }, true);

    targetWindow.addEventListener("paste", (event) => {
      if (!isEditable(event.target)) return;
      const text = (event.clipboardData && event.clipboardData.getData("text")) || "";
      const added = text.length || 1;
      lastStructuredInputAt = Date.now();
      sendDelta({ added, removed: 0, modified: 0, events: 1 });
    }, true);

    targetWindow.addEventListener("cut", (event) => {
      if (!isEditable(event.target)) return;
      lastStructuredInputAt = Date.now();
      sendDelta({ added: 0, removed: 1, modified: 0, events: 1 });
    }, true);

    targetWindow.addEventListener("keydown", (event) => {
      if (!isEditable(event.target)) return;
      const fallback = deltaFromKeydown(event);
      if (!fallback) return;

      const firedAt = Date.now();
      setTimeout(() => {
        if (lastStructuredInputAt >= firedAt) return;
        sendDelta(fallback);
      }, 75);
    }, true);
  }

  attachActivityListeners(window);

  // Periodically attach to newly created iframes (like the Docs input iframe)
  setInterval(() => {
    const frames = document.querySelectorAll("iframe");
    for (const frame of frames) {
      try {
        if (frame.contentWindow) {
          attachActivityListeners(frame.contentWindow);
        }
      } catch (_) {}
    }
  }, 1000);

  sendDocMeta();
  const titleNode = document.querySelector("title");
  if (titleNode) {
    new MutationObserver(sendDocMeta).observe(titleNode, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  let creds = null;
  let overlay = null;
  let overlayState = {
    visible: {
      charactersAdded: 0,
      charactersRemoved: 0,
      charactersModified: 0
    },
    docName: getDocName(),
    lastHeartbeatStatus: "waiting",
    connectionStatus: "disconnected"
  };

  function loadCreds(callback) {
    chrome.storage.sync.get({ username: "", team: "", token: "" }, (settings) => {
      creds = settings.username && settings.team && settings.token ? settings : null;
      callback(Boolean(creds));
    });
  }

  function createOverlay() {
    overlay = document.createElement("div");
    overlay.id = "seam-overlay";
    overlay.innerHTML = `
      <div id="seam-dot"></div>
      <div id="seam-info">
        <span id="seam-status">Loading...</span>
        <span id="seam-stats"></span>
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #seam-overlay {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 999999;
        display: flex;
        align-items: center;
        gap: 12px;
        background: rgba(255, 255, 255, 0.4);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        color: #111;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        font-size: 13px;
        padding: 8px;
        border-radius: 20px;
        border: 1px solid rgba(255, 255, 255, 0.4);
        box-shadow: 0 4px 12px rgba(0,0,0,0.06);
        user-select: none;
        transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
        width: 26px;
        height: 26px;
        box-sizing: border-box;
        overflow: hidden;
        cursor: pointer;
      }
      #seam-overlay:hover {
        background: rgba(255, 255, 255, 0.9);
        box-shadow: 0 12px 32px rgba(0,0,0,0.1);
        width: auto;
        height: auto;
        padding: 10px 16px;
        border-radius: 14px;
      }
      #seam-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #ff453a;
        flex-shrink: 0;
        box-shadow: 0 0 0 2px rgba(255, 69, 58, 0.2);
        transition: transform 0.2s ease;
      }
      #seam-overlay:hover #seam-dot {
        width: 8px;
        height: 8px;
      }
      #seam-dot.ok { 
        background: #30d158; 
        box-shadow: 0 0 0 2px rgba(48, 209, 88, 0.2);
      }
      #seam-dot.pulse {
        animation: heartbeatPulse 0.5s cubic-bezier(0.4, 0, 0.6, 1);
      }
      @keyframes heartbeatPulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.6); opacity: 0.7; }
      }
      #seam-info { 
        display: flex; 
        flex-direction: column; 
        gap: 2px;
        opacity: 0;
        transform: translateX(10px);
        transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
        white-space: nowrap;
      }
      #seam-overlay:hover #seam-info {
        opacity: 1;
        transform: translateX(0);
      }
      #seam-status { font-weight: 600; font-size: 12px; letter-spacing: -0.2px; }
      #seam-stats { font-size: 11px; color: #555; font-weight: 500; }
    `;

    function inject() {
      if (!document.body) {
        requestAnimationFrame(inject);
        return;
      }
      document.body.appendChild(style);
      document.body.appendChild(overlay);
      updateOverlay();
    }

    inject();
  }

  function updateOverlay() {
    if (!overlay) return;
    const dot = overlay.querySelector("#seam-dot");
    const status = overlay.querySelector("#seam-status");
    const stats = overlay.querySelector("#seam-stats");

    if (!creds) {
      dot.className = "";
      status.textContent = "No credentials — open Seam options";
      stats.textContent = "";
      return;
    }

    dot.className = overlayState.connectionStatus === "connected" ? "ok" : "";
    status.textContent =
      `${creds.username} @ ${creds.team} · ${overlayState.lastHeartbeatStatus}`;
      
    const wordsAdded = Math.max(0, Math.floor(overlayState.visible.charactersAdded / 5));
    const wordsRemoved = Math.max(0, Math.floor(overlayState.visible.charactersRemoved / 5));
    
    stats.textContent =
      `+${wordsAdded} / -${wordsRemoved} words | ${overlayState.docName || getDocName()}`;
  }

  function refreshOverlayState() {
    sendRuntimeMessage({ type: "get-tracking-state" }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      overlayState = {
        visible: response.visible || overlayState.visible,
        docName: response.docName || getDocName(),
        lastHeartbeatStatus: response.lastHeartbeatStatus || "waiting",
        connectionStatus: response.connectionStatus || "disconnected"
      };
      updateOverlay();
    });
  }

  function flushHeartbeat() {
    if (!creds) return;
    sendRuntimeMessage({ type: "flush-heartbeat" }, (res) => {
      if (res && res.payload) {
        console.log("Seam Heartbeat Sent:", res.payload);
        if (overlay) {
          const dot = overlay.querySelector("#seam-dot");
          if (dot) {
            dot.classList.add("pulse");
            setTimeout(() => dot.classList.remove("pulse"), 500);
          }
        }
      }
      refreshOverlayState();
    });
  }

  function requestScreenshot() {
    if (!creds) return;
    sendRuntimeMessage({ type: "take-screenshot", meta: { document_name: overlayState.docName || getDocName() } }, (res) => {
      if (res && res.url) {
        console.log("Seam Screenshot Sent:", res.url);
      }
    });
  }

  if (isTopFrame) {
    createOverlay();
    loadCreds(() => {
      refreshOverlayState();
      setInterval(() => loadCreds(() => updateOverlay()), 5000);
      setInterval(refreshOverlayState, 500);
      setInterval(flushHeartbeat, 5000);
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === "trigger-screenshot") {
        requestScreenshot();
      }
    });
  }
})();
