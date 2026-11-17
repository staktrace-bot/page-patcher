/*
 * Page Patcher UI. Runs as the toolbar popup, inside the in-page panel
 * (?embedded=1&tabId=N), or in a tab of its own (?tabId=N).
 */
"use strict";

const params = new URLSearchParams(location.search);
const embedded = params.get("embedded") === "1";
const $ = (id) => document.getElementById(id);

let tabId = params.has("tabId") ? Number(params.get("tabId")) : null;
let pageState = null;
let saved = [];
let storageKey = null;
let busy = false;

function opsText(ops) {
  return JSON.stringify(ops, null, 1);
}

function warningsFor(results, dropped) {
  const notes = [];
  const missed = (results || []).filter((r) => !r.error && r.matches === 0).length;
  const failed = (results || []).filter((r) => r.error);
  if (missed) notes.push(missed + " of " + results.length + " changes didn't match anything on the page.");
  for (const f of failed) notes.push("A " + f.type + " change failed: " + f.error);
  if (dropped && dropped.length) notes.push(dropped.length + " invalid change(s) from the model were skipped.");
  return notes.join(" ");
}

// Extension frames normally get the full API, but relay through the
// background script if this context lacks tabs.* (seen with some process
// configurations for frames embedded in web pages).
function send(msg) {
  if (browser.tabs && browser.tabs.sendMessage) return browser.tabs.sendMessage(tabId, msg);
  return browser.runtime.sendMessage({ type: "relay", tabId, msg });
}

async function refreshState() {
  try {
    pageState = await send({ type: "getState" });
  } catch (e) {
    pageState = null;
  }
}

async function loadSaved() {
  if (!storageKey) return;
  const r = await browser.storage.local.get(storageKey);
  saved = Array.isArray(r[storageKey]) ? r[storageKey] : [];
}

async function writeSaved(list) {
  saved = list;
  await browser.storage.local.set({ [storageKey]: list });
}

let lastDropped = null;

function render() {
  if (!pageState) {
    $("unavailable").hidden = false;
    $("main").hidden = true;
    return;
  }
  $("unavailable").hidden = true;
  $("main").hidden = false;
  $("host").textContent = pageState.hostname;
  $("host2").textContent = pageState.hostname;

  const d = pageState.draft;
  $("draft").hidden = !d;
  if (d) {
    $("draft-desc").textContent = d.patch.description;
    const warn = warningsFor(d.results, lastDropped);
    $("draft-warn").hidden = !warn;
    $("draft-warn").textContent = warn;
    $("draft-ops").textContent = opsText(d.patch.ops);
    $("draft-path-label").textContent = "Only on this page (" + pageState.pathname + ")";
  }

  const list = $("saved");
  list.textContent = "";
  $("saved-empty").hidden = saved.length > 0;
  const tpl = $("item-tpl");
  for (const p of saved) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    const applied = !!pageState.applied[p.id];
    const onPath = !p.pathPattern || globMatch(p.pathPattern, pageState.pathname);
    li.querySelector(".desc").textContent = p.description;
    const meta = [];
    meta.push(p.ops.length + (p.ops.length === 1 ? " change" : " changes"));
    if (p.pathPattern) meta.push("only " + p.pathPattern + (onPath ? "" : " (not this page)"));
    if (p.instruction) meta.push("“" + p.instruction.slice(0, 80) + "”");
    const results = pageState.applied[p.id];
    if (applied && results) {
      const w = warningsFor(results);
      if (w) meta.push(w);
    }
    li.querySelector(".meta").textContent = meta.join(" · ");
    li.querySelector(".ops").textContent = opsText(p.ops);
    const toggle = li.querySelector(".enabled");
    toggle.checked = !!p.enabled;
    toggle.setAttribute("aria-label", "Apply automatically: " + p.description);
    toggle.addEventListener("change", () => updateSaved(p.id, { enabled: toggle.checked }));
    const applyBtn = li.querySelector(".apply");
    if (p.enabled) {
      applyBtn.textContent = "Re-apply";
      applyBtn.addEventListener("click", () => send({ type: "reapply" }).then(refreshAndRender));
    } else if (applied) {
      applyBtn.textContent = "Undo";
      applyBtn.addEventListener("click", () => send({ type: "undoOnce", id: p.id }).then(refreshAndRender));
    } else {
      applyBtn.textContent = "Apply now";
      applyBtn.addEventListener("click", () => send({ type: "applyOnce", id: p.id }).then(refreshAndRender));
    }
    li.querySelector(".delete").addEventListener("click", () => writeSaved(saved.filter((x) => x.id !== p.id)).then(refreshAndRender));
    list.append(li);
  }
}

function globMatch(glob, path) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + esc + "$").test(path);
}

async function updateSaved(id, changes) {
  await writeSaved(saved.map((p) => (p.id === id ? { ...p, ...changes } : p)));
  // The content script reacts to the storage change; give it a moment.
  setTimeout(refreshAndRender, 150);
}

async function refreshAndRender() {
  await refreshState();
  render();
}

function setBusy(on, text) {
  busy = on;
  $("generate").disabled = on;
  $("status").textContent = text || "";
}

function showError(msg) {
  $("error").hidden = !msg;
  $("error").textContent = msg || "";
}

function generate() {
  const instruction = $("prompt").value.trim();
  if (!instruction || busy) return;
  showError("");
  setBusy(true, "Starting…");
  const port = browser.runtime.connect({ name: "generate" });
  port.onMessage.addListener(async (msg) => {
    if (msg.type === "progress") {
      $("status").textContent = msg.text;
      return;
    }
    port.disconnect();
    setBusy(false);
    if (msg.type === "error") {
      showError(msg.message);
      if (msg.code === "no_key") $("nokey").hidden = false;
      return;
    }
    lastDropped = msg.dropped;
    if (!msg.patch.ops.length) {
      showError("No changes made: " + msg.patch.description);
      return;
    }
    $("prompt").value = "";
    $("status").textContent = msg.usedScreenshot ? "Done (used a screenshot)." : "Done.";
    await refreshAndRender();
  });
  port.onDisconnect.addListener(() => {
    if (busy) {
      setBusy(false);
      showError("Lost connection to the background script.");
    }
  });
  port.postMessage({ tabId, instruction });
}

async function saveDraft() {
  const d = pageState && pageState.draft;
  if (!d) return;
  const entry = {
    id: d.patch.id,
    description: d.patch.description,
    ops: d.patch.ops,
    instruction: d.patch.instruction || "",
    createdAt: d.patch.createdAt || Date.now(),
    enabled: true,
    pathPattern: $("draft-path").checked ? pageState.pathname : "",
  };
  await writeSaved([...saved.filter((p) => p.id !== entry.id), entry]);
  $("draft-path").checked = false;
  setTimeout(refreshAndRender, 150);
}

function openOptions(e) {
  e.preventDefault();
  if (browser.runtime.openOptionsPage) browser.runtime.openOptionsPage();
  else browser.runtime.sendMessage({ type: "openOptions" });
  if (!embedded && !params.has("tabId")) window.close();
}

async function init() {
  // Tell the in-page panel we loaded (it falls back to a tab otherwise).
  // The message carries no data, so any target origin is fine.
  if (embedded) parent.postMessage({ pagePatcher: "ready" }, "*");
  const { isAndroid } = await browser.runtime.sendMessage({ type: "getConfig" });
  if (isAndroid || embedded || params.has("tabId")) document.body.classList.add("fluid");
  if (embedded) {
    $("close").hidden = false;
    $("close").addEventListener("click", () => parent.postMessage({ pagePatcher: "close" }, "*"));
  }
  if (tabId === null) {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    tabId = tab ? tab.id : null;
  }
  $("options").addEventListener("click", openOptions);
  $("nokey-link").addEventListener("click", openOptions);
  $("generate").addEventListener("click", generate);
  $("prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) generate();
  });
  $("draft-undo").addEventListener("click", () => send({ type: "undoDraft" }).then(refreshAndRender));
  $("draft-save").addEventListener("click", saveDraft);

  const { settings } = await browser.storage.local.get("settings");
  $("nokey").hidden = !!(settings && settings.apiKey);

  await refreshState();
  if (pageState) {
    storageKey = "patches:" + pageState.hostname;
    await loadSaved();
  }
  render();
  if (pageState && !embedded) $("prompt").focus();

  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes.settings) $("nokey").hidden = !!(changes.settings.newValue && changes.settings.newValue.apiKey);
    if (storageKey && changes[storageKey]) {
      saved = changes[storageKey].newValue || [];
      render();
    }
  });
}

init();
