/**
 * Hospital Chatbot Widget v1
 *
 * Sử dụng đơn giản:
 *   <script src="http://localhost:8080/widget.js"></script>
 *
 * Với options:
 *   <script>
 *     window.HospitalChatbotConfig = {
 *       apiBase: 'https://chatbot.benhvien.vn',
 *       title: 'Trợ lý BV ABC',
 *       primaryColor: '#0f5ea8',
 *       position: 'bottom-right',
 *       hideSuggest: false,
 *       autoOpen: false
 *     };
 *   </script>
 *   <script src="http://localhost:8080/widget.js"></script>
 */
(function () {
  if (window.__hospitalChatbotLoaded) return;
  window.__hospitalChatbotLoaded = true;

  const cfg = Object.assign(
    {
      apiBase: null,
      title: "Hospital Chatbot",
      welcome: null,
      primaryColor: "#0f5ea8",
      position: "bottom-right",
      hideSuggest: false,
      autoOpen: false,
      bubbleLabel: "Chat",
    },
    window.HospitalChatbotConfig || {},
  );

  if (!cfg.apiBase) {
    const scripts = document.getElementsByTagName("script");
    for (let i = scripts.length - 1; i >= 0; i--) {
      const src = scripts[i].src || "";
      if (src.indexOf("widget.js") >= 0) {
        cfg.apiBase = src.substring(0, src.indexOf("/widget.js"));
        break;
      }
    }
  }
  if (!cfg.apiBase) cfg.apiBase = window.location.origin;

  const style = document.createElement("style");
  style.textContent = `
    .hospital-chatbot-bubble {
      position: fixed;
      ${cfg.position === "bottom-left" ? "left: 24px" : "right: 24px"};
      bottom: 24px;
      width: 60px; height: 60px;
      border-radius: 50%;
      background: ${cfg.primaryColor};
      color: white;
      border: 0;
      cursor: pointer;
      box-shadow: 0 6px 20px rgba(15, 23, 42, 0.25);
      display: flex; align-items: center; justify-content: center;
      font-size: 26px;
      z-index: 999998;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .hospital-chatbot-bubble:hover {
      transform: scale(1.08);
      box-shadow: 0 8px 28px rgba(15, 23, 42, 0.35);
    }
    .hospital-chatbot-bubble.open { transform: scale(0.92); }

    .hospital-chatbot-panel {
      position: fixed;
      ${cfg.position === "bottom-left" ? "left: 24px" : "right: 24px"};
      bottom: 100px;
      width: 380px; height: 580px;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 130px);
      background: white;
      border-radius: 16px;
      box-shadow: 0 12px 40px rgba(15, 23, 42, 0.25);
      overflow: hidden;
      z-index: 999999;
      display: none;
      flex-direction: column;
      animation: hcb-slide-up 0.25s ease;
    }
    .hospital-chatbot-panel.open { display: flex; }
    .hospital-chatbot-panel iframe { width: 100%; height: 100%; border: 0; }

    @keyframes hcb-slide-up {
      from { opacity: 0; transform: translateY(20px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    @media (max-width: 480px) {
      .hospital-chatbot-panel {
        width: calc(100vw - 16px);
        height: calc(100vh - 100px);
        right: 8px !important; left: 8px !important;
        bottom: 90px;
      }
    }
  `;
  document.head.appendChild(style);

  const bubble = document.createElement("button");
  bubble.className = "hospital-chatbot-bubble";
  bubble.setAttribute("aria-label", cfg.bubbleLabel);
  bubble.innerHTML = "💬";

  const panel = document.createElement("div");
  panel.className = "hospital-chatbot-panel";

  const iframe = document.createElement("iframe");
  iframe.src = cfg.apiBase + "/embed.html";
  iframe.title = cfg.title;
  iframe.setAttribute("allow", "clipboard-write");

  panel.appendChild(iframe);
  document.body.appendChild(panel);
  document.body.appendChild(bubble);

  let isOpen = false;
  function toggle(open) {
    isOpen = typeof open === "boolean" ? open : !isOpen;
    panel.classList.toggle("open", isOpen);
    bubble.classList.toggle("open", isOpen);
    bubble.innerHTML = isOpen ? "✕" : "💬";
  }
  bubble.addEventListener("click", () => toggle());

  let iframeReady = false;
  function sendConfigToIframe() {
    if (!iframeReady) return;
    iframe.contentWindow.postMessage(
      {
        type: "chatbot:config",
        apiBase: cfg.apiBase,
        title: cfg.title,
        welcome: cfg.welcome,
        hideSuggest: cfg.hideSuggest,
      },
      "*",
    );
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "chatbot:ready") {
      iframeReady = true;
      sendConfigToIframe();
    } else if (msg.type === "chatbot:close") {
      toggle(false);
    }
  });

  window.HospitalChatbot = {
    open: () => toggle(true),
    close: () => toggle(false),
    toggle: () => toggle(),
  };

  if (cfg.autoOpen) setTimeout(() => toggle(true), 500);
})();
