/*
 * Page Patcher background script (an event page in Firefox MV3).
 * Talks to the xAI API, injects CSS, and answers small queries from content
 * scripts and the popup.
 */
"use strict";

const { RESPONSE_SCHEMA, validatePatchResponse } = globalThis.PagePatcherSchema;
const { buildMessages, wantsScreenshot } = globalThis.PagePatcherPrompt;

const API_URL = "https://api.x.ai/v1/chat/completions";
const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "grok-4.7",
  screenshot: "auto", // auto | always | never
  floatingButton: "auto", // auto (Android only) | on | off
};

async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

let platformPromise = null;
function getPlatform() {
  if (!platformPromise) platformPromise = browser.runtime.getPlatformInfo().then((p) => p.os);
  return platformPromise;
}

function newId() {
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// --------------------------------------------------------------- xAI calls

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function chat(settings, messages, responseFormat, signal) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.apiKey },
    body: JSON.stringify({ model: settings.model, messages, response_format: responseFormat }),
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = (j.error && (j.error.message || j.error)) || j.message || text;
    } catch (e) {
      /* keep text */
    }
    throw new ApiError("xAI API error " + res.status + ": " + String(msg).slice(0, 300), res.status, text);
  }
  const data = JSON.parse(text);
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== "string") throw new ApiError("xAI API returned no message content", res.status, text);
  return { content, usage: data.usage || null };
}

const JSON_SCHEMA_FORMAT = { type: "json_schema", json_schema: { name: "page_patch", schema: RESPONSE_SCHEMA, strict: true } };
const JSON_OBJECT_FORMAT = { type: "json_object" };
let schemaUnsupported = false;

// Calls the model, falling back from json_schema to json_object and from
// image input to text-only if the API rejects either, and retries once with
// the validation errors if the output doesn't validate.
async function generatePatch(settings, { instruction, summary, draft, screenshot }, signal) {
  let image = screenshot || null;
  let previousError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const messages = buildMessages({ instruction, summary, draft, screenshot: image, previousError });
    let reply;
    try {
      reply = await chat(settings, messages, schemaUnsupported ? JSON_OBJECT_FORMAT : JSON_SCHEMA_FORMAT, signal);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400 && !schemaUnsupported && /schema|response_format/i.test(e.message)) {
        schemaUnsupported = true;
        continue;
      }
      if (e instanceof ApiError && e.status === 400 && image && /image|vision|content/i.test(e.message)) {
        image = null;
        continue;
      }
      throw e;
    }
    const v = validatePatchResponse(reply.content);
    if (v.ok) return { ...v, usedScreenshot: !!image, raw: reply.content };
    if (previousError) throw new Error("The model's response was invalid: " + v.errors.join("; "));
    previousError = { raw: reply.content, errors: v.errors };
  }
  throw new Error("Could not get a valid patch from the model");
}

async function captureScreenshot(tabId) {
  const tab = await browser.tabs.get(tabId);
  if (!tab.active) return null; // e.g. UI opened in its own tab
  try {
    await browser.tabs.sendMessage(tabId, { type: "captureHide" });
    return await browser.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
  } catch (e) {
    console.warn("Page Patcher: screenshot failed", e);
    return null;
  } finally {
    browser.tabs.sendMessage(tabId, { type: "captureShow" }).catch(() => {});
  }
}

async function runGeneration(tabId, instruction, progress, signal) {
  const settings = await getSettings();
  if (!settings.apiKey) throw Object.assign(new Error("Add your xAI API key in Page Patcher's options first."), { code: "no_key" });
  progress("Reading the page…");
  const page = await browser.tabs.sendMessage(tabId, { type: "summarize" });
  let screenshot = null;
  if (wantsScreenshot(instruction, settings.screenshot)) {
    progress("Taking a screenshot…");
    screenshot = await captureScreenshot(tabId);
  }
  progress("Asking " + settings.model + "…");
  const result = await generatePatch(settings, { instruction, summary: page.summary, draft: page.draft, screenshot }, signal);
  const patch = {
    id: newId(),
    description: result.patch.description,
    ops: result.patch.ops,
    instruction,
    createdAt: Date.now(),
  };
  let applied = { results: [] };
  if (patch.ops.length) {
    progress("Applying…");
    applied = await browser.tabs.sendMessage(tabId, { type: "setDraft", patch });
  }
  return { patch, results: applied.results, dropped: result.dropped, usedScreenshot: result.usedScreenshot };
}

// Generation runs over a port: an open port keeps the event page alive for
// the length of the request and lets us stream progress messages.
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "generate") return;
  // If the popup closes mid-request (desktop popups close on blur) we keep
  // going: the draft still gets applied and shows up when the popup reopens.
  const controller = new AbortController();
  let connected = true;
  port.onDisconnect.addListener(() => (connected = false));
  const send = (m) => {
    if (connected) port.postMessage(m);
  };
  port.onMessage.addListener(async (msg) => {
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const out = await runGeneration(msg.tabId, msg.instruction, (text) => send({ type: "progress", text }), controller.signal);
      send({ type: "done", ...out });
    } catch (e) {
      send({ type: "error", message: e.name === "AbortError" ? "The request timed out." : e.message, code: e.code || null });
    } finally {
      clearTimeout(timeout);
    }
  });
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== "string") return undefined;
  switch (msg.type) {
    case "whoami":
      return Promise.resolve({ tabId: sender.tab ? sender.tab.id : null });
    case "getConfig":
      return Promise.all([getSettings(), getPlatform()]).then(([s, os]) => ({
        isAndroid: os === "android",
        floatingButton: s.floatingButton === "on" || (s.floatingButton === "auto" && os === "android"),
      }));
    case "insertCSS":
    case "removeCSS": {
      if (!sender.tab) return undefined;
      const target = { tabId: sender.tab.id, frameIds: [sender.frameId || 0] };
      const fn = msg.type === "insertCSS" ? browser.scripting.insertCSS : browser.scripting.removeCSS;
      return fn({ target, css: msg.css, origin: "AUTHOR" }).then(() => true);
    }
    case "openPanelTab":
      return browser.tabs.create({ url: browser.runtime.getURL("popup/popup.html") + "?tabId=" + msg.tabId }).then(() => true);
    case "relay":
      // Only extension pages (popup/panel) may relay; content scripts have a sender.tab.
      if (sender.tab && !sender.url.startsWith(browser.runtime.getURL(""))) return undefined;
      return browser.tabs.sendMessage(msg.tabId, msg.msg);
    case "openOptions":
      return browser.runtime.openOptionsPage().then(() => true);
    case "testKey":
      return testKey(msg.apiKey, msg.model);
    default:
      return undefined;
  }
});

async function testKey(apiKey, model) {
  try {
    const out = await chat({ apiKey, model }, [{ role: "user", content: 'Reply with {"ok": true}' }], JSON_OBJECT_FORMAT);
    return { ok: true, reply: out.content.slice(0, 100) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") {
    const s = await getSettings();
    if (!s.apiKey) browser.runtime.openOptionsPage();
  }
});
