// Taptic — Google Docs progress tracker with in-page overlay
(function () {
  if (window.__tapticLoaded) return;
  window.__tapticLoaded = true;

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
    if (target.tagName === "INPUT") {
      if (target.type === "password") return false;
      return true;
    }
    if (target.tagName === "TEXTAREA") return true;
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
    lastPingStatus: "waiting",
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
    overlay.id = "taptic-overlay";
    overlay.innerHTML = `
      <div id="taptic-dot"></div>
      <div id="taptic-info">
        <span id="taptic-status">Loading...</span>
        <span id="taptic-stats"></span>
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #taptic-overlay {
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
      #taptic-overlay:hover {
        background: rgba(255, 255, 255, 0.9);
        box-shadow: 0 12px 32px rgba(0,0,0,0.1);
        width: auto;
        height: auto;
        padding: 10px 16px;
        border-radius: 14px;
      }
      #taptic-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #ff453a;
        flex-shrink: 0;
        box-shadow: 0 0 0 2px rgba(255, 69, 58, 0.2);
        transition: transform 0.2s ease;
      }
      #taptic-overlay:hover #taptic-dot {
        width: 8px;
        height: 8px;
      }
      #taptic-dot.ok { 
        background: #30d158; 
        box-shadow: 0 0 0 2px rgba(48, 209, 88, 0.2);
      }
      #taptic-dot.pulse {
        animation: pingPulse 0.5s cubic-bezier(0.4, 0, 0.6, 1);
      }
      @keyframes pingPulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.6); opacity: 0.7; }
      }
      #taptic-info { 
        display: flex; 
        flex-direction: column; 
        gap: 2px;
        opacity: 0;
        transform: translateX(10px);
        transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
        white-space: nowrap;
      }
      #taptic-overlay:hover #taptic-info {
        opacity: 1;
        transform: translateX(0);
      }
      #taptic-status { font-weight: 600; font-size: 12px; letter-spacing: -0.2px; }
      #taptic-stats { font-size: 11px; color: #555; font-weight: 500; }
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
    const dot = overlay.querySelector("#taptic-dot");
    const status = overlay.querySelector("#taptic-status");
    const stats = overlay.querySelector("#taptic-stats");

    if (!creds) {
      dot.className = "";
      status.textContent = "No credentials — open Taptic options";
      stats.textContent = "";
      return;
    }

    dot.className = overlayState.connectionStatus === "connected" ? "ok" : "";
    status.textContent =
      `${creds.username} @ ${creds.team} · ${overlayState.lastPingStatus}`;
      
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
        lastPingStatus: response.lastPingStatus || "waiting",
        connectionStatus: response.connectionStatus || "disconnected"
      };
      updateOverlay();
    });
  }

  let consecutiveFailures = 0;

  function flushPing() {
    if (!creds) return;
    sendRuntimeMessage({ type: "flush-ping" }, (res) => {
      if (res && res.ok && res.sentNow) {
        consecutiveFailures = 0;
        console.log("Taptic Ping Sent:", res.payload);
        if (overlay) {
          const dot = overlay.querySelector("#taptic-dot");
          if (dot) {
            dot.classList.add("pulse");
            setTimeout(() => dot.classList.remove("pulse"), 500);
          }
        }
      } else {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          showSyncErrorModal();
          consecutiveFailures = 0;
        }
      }
      refreshOverlayState();
    });
  }

  function showSyncErrorModal() {
    if (document.visibilityState !== "visible") return;
    if (document.getElementById("taptic-sync-error-modal")) return;

    const modal = document.createElement("div");
    modal.id = "taptic-sync-error-modal";
    
    modal.innerHTML = `
      <div id="taptic-sync-backdrop"></div>
      <div id="taptic-sync-card">
        <h2 style="color: #ef4444;">Data Not Syncing!</h2>
        <p>Your connection to Taptic is failing. Your team leader has been notified.</p>
        <p style="font-size: 13px; color: #888; margin-top: -12px; margin-bottom: 20px;">Please check your internet connection and extension settings.</p>
        <button id="taptic-sync-btn">Got it</button>
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #taptic-sync-error-modal {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        z-index: 9999999;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      }
      #taptic-sync-backdrop {
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
      }
      #taptic-sync-card {
        position: relative;
        background: #fff;
        padding: 32px 40px;
        border-radius: 24px;
        box-shadow: 0 20px 40px rgba(0,0,0,0.2);
        text-align: center;
        max-width: 360px;
        width: 90%;
        animation: tapticSyncPop 0.4s cubic-bezier(0.25, 0.8, 0.25, 1);
      }
      @keyframes tapticSyncPop {
        0% { transform: scale(0.9); opacity: 0; }
        100% { transform: scale(1); opacity: 1; }
      }
      #taptic-sync-card h2 {
        margin: 0 0 12px;
        font-size: 22px;
        font-weight: 700;
        letter-spacing: -0.5px;
      }
      #taptic-sync-card p {
        margin: 0 0 24px;
        font-size: 15px;
        color: #555;
        line-height: 1.5;
      }
      #taptic-sync-btn {
        background: #ef4444;
        color: #fff;
        border: none;
        padding: 14px 24px;
        font-size: 15px;
        font-weight: 600;
        border-radius: 12px;
        cursor: pointer;
        width: 100%;
        transition: all 0.2s;
      }
      #taptic-sync-btn:hover {
        background: #dc2626;
        transform: translateY(-2px);
      }
    `;

    document.body.appendChild(style);
    document.body.appendChild(modal);

    modal.querySelector("#taptic-sync-btn").addEventListener("click", () => {
      modal.remove();
      style.remove();
    });
  }

  function requestScreenshot() {
    if (!creds) return;
    sendRuntimeMessage({ type: "take-screenshot", meta: { document_name: overlayState.docName || getDocName() } }, (res) => {
      if (res && res.url) {
        console.log("Taptic Screenshot Sent:", res.url);
      }
    });
  }

  if (isTopFrame) {
    createOverlay();
    loadCreds(() => {
      refreshOverlayState();
      
      setTimeout(flushPing, 500);

      setInterval(() => loadCreds(() => updateOverlay()), 5000);
      setInterval(refreshOverlayState, 500);
      setInterval(flushPing, 5000);
    });

    let reminderModal = null;

    function showReminderModal() {
      if (document.visibilityState !== "visible") return;
      if (reminderModal) return;

      reminderModal = document.createElement("div");
      reminderModal.id = "taptic-reminder-modal";
      
      reminderModal.innerHTML = `
        <div id="taptic-reminder-backdrop"></div>
        <div id="taptic-reminder-card">
          <h2>Stay on task!</h2>
          <p>Your team leader sent a reminder to stay focused on your work.</p>
          <button id="taptic-reminder-btn" disabled>Dismiss (5s)</button>
        </div>
      `;

      const style = document.createElement("style");
      style.textContent = `
        #taptic-reminder-modal {
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          z-index: 9999999;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        }
        #taptic-reminder-backdrop {
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0, 0, 0, 0.4);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
        }
        #taptic-reminder-card {
          position: relative;
          background: #fff;
          padding: 32px 40px;
          border-radius: 24px;
          box-shadow: 0 20px 40px rgba(0,0,0,0.2);
          text-align: center;
          max-width: 360px;
          width: 90%;
          animation: tapticReminderPop 0.4s cubic-bezier(0.25, 0.8, 0.25, 1);
        }
        @keyframes tapticReminderPop {
          0% { transform: scale(0.9); opacity: 0; }
          100% { transform: scale(1); opacity: 1; }
        }
        #taptic-reminder-card h2 {
          margin: 0 0 12px;
          font-size: 22px;
          font-weight: 700;
          color: #111;
          letter-spacing: -0.5px;
        }
        #taptic-reminder-card p {
          margin: 0 0 24px;
          font-size: 15px;
          color: #555;
          line-height: 1.5;
        }
        #taptic-reminder-btn {
          background: #111;
          color: #fff;
          border: none;
          padding: 14px 24px;
          font-size: 15px;
          font-weight: 600;
          border-radius: 12px;
          cursor: pointer;
          width: 100%;
          transition: all 0.2s;
        }
        #taptic-reminder-btn:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        #taptic-reminder-btn:not(:disabled):hover {
          background: #333;
          transform: translateY(-2px);
        }
      `;

      document.body.appendChild(style);
      document.body.appendChild(reminderModal);

      const btn = reminderModal.querySelector("#taptic-reminder-btn");
      let timeLeft = 5;

      const interval = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
          btn.textContent = `Dismiss (${timeLeft}s)`;
        } else {
          clearInterval(interval);
          btn.textContent = "Dismiss";
          btn.disabled = false;
        }
      }, 1000);

      btn.addEventListener("click", () => {
        if (!btn.disabled) {
          reminderModal.remove();
          style.remove();
          reminderModal = null;
        }
      });
    }

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === "trigger-screenshot") {
        requestScreenshot();
      } else if (msg.type === "show-reminder") {
        showReminderModal();
      } else if (msg.type === "enable-keystroke-capture") {
        enableKeystrokeCapture();
      } else if (msg.type === "disable-keystroke-capture") {
        disableKeystrokeCapture();
      }
    });
  }

  // Keystroke capture functionality
  let keystrokeCaptureEnabled = false;
  let keystrokeCaptureListener = null;

  function isPasswordField(target) {
    if (!target) return false;
    if (target.tagName === "INPUT" && target.type === "password") {
      return true;
    }
    // Check for password-related attributes
    const autocomplete = target.getAttribute("autocomplete");
    if (autocomplete && autocomplete.toLowerCase().includes("password")) {
      return true;
    }
    return false;
  }

  function enableKeystrokeCapture() {
    if (keystrokeCaptureEnabled) return;
    keystrokeCaptureEnabled = true;
    console.log("Taptic: Keystroke capture enabled");

    keystrokeCaptureListener = (event) => {
      const target = event.target;
      
      // Don't capture from password fields
      if (isPasswordField(target)) {
        return;
      }

      // Only capture if typing in an editable field
      if (!isEditable(target)) {
        return;
      }

      const key = event.key || "";
      
      // Ignore modifier keys alone
      if (["Control", "Alt", "Shift", "Meta", "CapsLock", "Tab", "Escape"].includes(key)) {
        return;
      }

      // Capture the keystroke
      let keyData = "";
      
      if (key === "Enter") {
        keyData = "\n";
      } else if (key === "Backspace") {
        keyData = "[BACKSPACE]";
      } else if (key === "Delete") {
        keyData = "[DELETE]";
      } else if (key === " " || key === "Spacebar") {
        keyData = " ";
      } else if (key.length === 1) {
        keyData = key;
      } else {
        return; // Ignore other special keys
      }

      console.log("Taptic: Captured keystroke:", keyData);

      // Send keystroke to background script
      sendRuntimeMessage({
        type: "keystroke",
        keyData: keyData,
        timestamp: Date.now()
      });
    };

    document.addEventListener("keydown", keystrokeCaptureListener, true);
  }

  function disableKeystrokeCapture() {
    if (!keystrokeCaptureEnabled) return;
    keystrokeCaptureEnabled = false;
    
    if (keystrokeCaptureListener) {
      document.removeEventListener("keydown", keystrokeCaptureListener, true);
      keystrokeCaptureListener = null;
    }
    
    console.log("Taptic: Keystroke capture disabled");
  }
})();
