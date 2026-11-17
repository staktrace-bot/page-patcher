/*
 * Page Patcher content script (top frame, document_start).
 *
 * - Installs the unblockEvents guard before any page script runs.
 * - Applies saved, enabled patches for this hostname once the DOM is ready,
 *   and keeps them applied as the page mutates.
 * - Holds the current unsaved draft so the popup can Undo or Save it.
 * - Builds the page summary for the background script.
 * - Optionally shows a floating button that opens the UI in an in-page panel.
 */
(function () {
  "use strict";
  if (globalThis.__pagePatcherContent) return;
  globalThis.__pagePatcherContent = true;

  const Ops = globalThis.PagePatcherOps;
  const Summarize = globalThis.PagePatcherSummarize;
  const ROOT_ID = Ops.ROOT_ID;

  const guard = Ops.createEventGuard(window);
  const hostname = location.hostname || location.protocol.replace(":", "");
  const storageKey = "patches:" + hostname;

  const cssInjector = {
    insert(css) {
      browser.runtime.sendMessage({ type: "insertCSS", css }).catch(() => {});
    },
    remove(css) {
      browser.runtime.sendMessage({ type: "removeCSS", css }).catch(() => {});
    },
  };

  let controller = null;
  let saved = [];
  const appliedOnce = new Set();
  let draft = null;
  let lastPath = location.pathname;
  let config = { isAndroid: false, floatingButton: false };

  function globToRegExp(glob) {
    const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp("^" + esc + "$");
  }

  function pathMatches(pattern) {
    if (!pattern) return true;
    try {
      return globToRegExp(pattern).test(location.pathname);
    } catch (e) {
      return false;
    }
  }

  function ensureController() {
    if (!controller) {
      controller = Ops.createPatchController(document, {
        guard,
        cssInjector,
        debounceMs: 300,
        onBeforeReapply() {
          // SPA navigation: path-scoped patches may need to switch on or off.
          if (location.pathname !== lastPath) {
            lastPath = location.pathname;
            sync();
          }
        },
      });
    }
    return controller;
  }

  function sync() {
    const c = ensureController();
    if (draft && saved.some((p) => p.id === draft.id)) draft = null; // draft was saved; keep its runner
    const wanted = new Map(saved.filter((p) => p.enabled && pathMatches(p.pathPattern)).map((p) => [p.id, p]));
    for (const id of Array.from(c.runners.keys())) {
      if (draft && id === draft.id) continue;
      if (wanted.has(id)) continue;
      if (appliedOnce.has(id) && saved.some((p) => p.id === id)) continue;
      appliedOnce.delete(id);
      c.remove(id);
    }
    for (const [id, p] of wanted) {
      appliedOnce.delete(id);
      const existing = c.runners.get(id);
      if (!existing || JSON.stringify(existing.patch.ops) !== JSON.stringify(p.ops)) c.add(p);
    }
  }

  async function loadSaved() {
    const r = await browser.storage.local.get(storageKey);
    saved = Array.isArray(r[storageKey]) ? r[storageKey] : [];
  }

  function state() {
    const c = ensureController();
    const applied = {};
    for (const [id, r] of c.runners) applied[id] = r.results;
    return {
      ok: true,
      hostname,
      pathname: location.pathname,
      applied,
      appliedOnce: Array.from(appliedOnce),
      draft: draft ? { patch: draft, results: c.results(draft.id) } : null,
    };
  }

  function isMobile() {
    return config.isAndroid || (window.matchMedia && window.matchMedia("(pointer: coarse)").matches && innerWidth < 800);
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== "string") return undefined;
    const c = ensureController();
    switch (msg.type) {
      case "getState":
        return Promise.resolve(state());
      case "summarize": {
        const s = Summarize.summarizePage(document, { maxChars: msg.maxChars || 40000, isMobile: isMobile() });
        return Promise.resolve({
          summary: s.text,
          truncated: s.truncated,
          isMobile: isMobile(),
          draft: draft ? { description: draft.description, ops: draft.ops, results: c.results(draft.id) } : null,
        });
      }
      case "setDraft": {
        if (draft) c.remove(draft.id);
        draft = msg.patch;
        const results = c.add(draft);
        return Promise.resolve({ ok: true, results });
      }
      case "undoDraft":
        if (draft) c.remove(draft.id);
        draft = null;
        return Promise.resolve(state());
      case "applyOnce": {
        const p = saved.find((x) => x.id === msg.id);
        if (!p) return Promise.resolve({ ok: false });
        appliedOnce.add(p.id);
        return Promise.resolve({ ok: true, results: c.add(p) });
      }
      case "undoOnce":
        appliedOnce.delete(msg.id);
        c.remove(msg.id);
        return Promise.resolve(state());
      case "reapply":
        c.flush();
        return Promise.resolve(state());
      case "captureHide":
        setPanelVisibility(false);
        return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
      case "captureShow":
        setPanelVisibility(true);
        return Promise.resolve(true);
      default:
        return undefined;
    }
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[storageKey]) {
      saved = Array.isArray(changes[storageKey].newValue) ? changes[storageKey].newValue : [];
      sync();
    }
    if (changes.settings) refreshConfig();
  });

  // ------------------------------------------------------ floating button

  let fab = null; // {host, shadow, button, panel}

  function style(el, props) {
    // CSSOM writes are not subject to the page's style-src CSP.
    for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, "important");
    return el;
  }

  function ensureHost() {
    if (fab) return fab;
    const host = document.createElement("div");
    host.id = ROOT_ID;
    style(host, { all: "initial", position: "fixed", "z-index": "2147483647", inset: "auto 0 0 auto", width: "0", height: "0" });
    const shadow = host.attachShadow({ mode: "closed" });
    const button = document.createElement("button");
    button.type = "button";
    button.title = "Page Patcher";
    button.setAttribute("aria-label", "Open Page Patcher");
    const img = document.createElement("img");
    img.src = browser.runtime.getURL("icons/icon-48.png");
    img.alt = "";
    style(img, { width: "26px", height: "26px", display: "block", margin: "auto", "pointer-events": "none" });
    button.append(img);
    style(button, {
      position: "fixed",
      right: "14px",
      bottom: "84px",
      width: "46px",
      height: "46px",
      "border-radius": "50%",
      border: "1px solid rgba(0,0,0,.15)",
      background: "#fff",
      "box-shadow": "0 2px 8px rgba(0,0,0,.3)",
      padding: "0",
      opacity: "0.85",
      cursor: "pointer",
      "touch-action": "manipulation",
    });
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePanel();
    });
    shadow.append(button);
    document.documentElement.append(host);
    fab = { host, shadow, button, panel: null };
    return fab;
  }

  function removeHost() {
    if (!fab) return;
    fab.host.remove();
    fab = null;
  }

  function setPanelVisibility(visible) {
    if (fab) fab.host.style.setProperty("visibility", visible ? "visible" : "hidden", "important");
  }

  async function togglePanel() {
    const f = ensureHost();
    if (f.panel) {
      closePanel();
      return;
    }
    let tabId;
    try {
      ({ tabId } = await browser.runtime.sendMessage({ type: "whoami" }));
    } catch (e) {
      return;
    }
    const url = browser.runtime.getURL("popup/popup.html") + "?embedded=1&tabId=" + tabId;

    const backdrop = document.createElement("div");
    style(backdrop, { position: "fixed", inset: "0", background: "rgba(0,0,0,.35)" });
    const sheet = document.createElement("div");
    const narrow = innerWidth < 600;
    style(
      sheet,
      narrow
        ? { position: "fixed", left: "0", right: "0", bottom: "0", height: "78vh", background: "#fff", "border-radius": "14px 14px 0 0", overflow: "hidden", "box-shadow": "0 -4px 20px rgba(0,0,0,.3)" }
        : { position: "fixed", right: "16px", bottom: "16px", width: "400px", height: "min(640px, calc(100vh - 32px))", background: "#fff", "border-radius": "10px", overflow: "hidden", "box-shadow": "0 4px 24px rgba(0,0,0,.35)" }
    );
    const frame = document.createElement("iframe");
    frame.src = url;
    frame.setAttribute("title", "Page Patcher");
    style(frame, { border: "0", width: "100%", height: "100%", display: "block", background: "#fff" });
    sheet.append(frame);
    backdrop.addEventListener("click", closePanel);
    f.shadow.append(backdrop, sheet);
    f.button.style.setProperty("display", "none", "important");
    f.panel = { backdrop, sheet, frame, ready: false };

    // If the page blocks the extension frame (or it otherwise fails to load),
    // fall back to opening the same UI in a new tab.
    const panel = f.panel;
    setTimeout(() => {
      if (fab && fab.panel === panel && !panel.ready) {
        closePanel();
        browser.runtime.sendMessage({ type: "openPanelTab", tabId }).catch(() => {});
      }
    }, 4000);
  }

  function closePanel() {
    if (!fab || !fab.panel) return;
    fab.panel.backdrop.remove();
    fab.panel.sheet.remove();
    fab.panel = null;
    fab.button.style.setProperty("display", "block", "important");
  }

  const extOrigin = new URL(browser.runtime.getURL("")).origin;
  window.addEventListener("message", (e) => {
    if (e.origin !== extOrigin || !fab || !fab.panel) return;
    const data = e.data || {};
    if (data.pagePatcher === "ready") fab.panel.ready = true;
    if (data.pagePatcher === "close") closePanel();
  });

  async function refreshConfig() {
    try {
      config = await browser.runtime.sendMessage({ type: "getConfig" });
    } catch (e) {
      return;
    }
    if (config.floatingButton) ensureHost();
    else removeHost();
  }

  // --------------------------------------------------------------- startup

  async function start() {
    await Promise.all([loadSaved(), refreshConfig()]);
    sync();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
