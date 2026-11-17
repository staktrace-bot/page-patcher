"use strict";

const DEFAULTS = { apiKey: "", model: "grok-4.7", screenshot: "auto", floatingButton: "auto" };
const $ = (id) => document.getElementById(id);
const FIELDS = ["apiKey", "model", "screenshot", "floatingButton"];

async function load() {
  const { settings } = await browser.storage.local.get("settings");
  const s = { ...DEFAULTS, ...(settings || {}) };
  for (const f of FIELDS) $(f).value = s[f];
  countPatches();
}

function read() {
  const s = {};
  for (const f of FIELDS) s[f] = $(f).value.trim();
  if (!s.model) s.model = DEFAULTS.model;
  return s;
}

async function save() {
  await browser.storage.local.set({ settings: read() });
  $("saved").textContent = "Saved.";
  setTimeout(() => ($("saved").textContent = ""), 2000);
}

async function countPatches() {
  const all = await browser.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("patches:"));
  const n = keys.reduce((sum, k) => sum + (all[k] || []).length, 0);
  $("patchCount").textContent = n + " saved patch" + (n === 1 ? "" : "es") + " across " + keys.length + " site" + (keys.length === 1 ? "" : "s") + ".";
}

$("showKey").addEventListener("click", () => {
  const shown = $("apiKey").type === "text";
  $("apiKey").type = shown ? "password" : "text";
  $("showKey").textContent = shown ? "Show" : "Hide";
});
$("save").addEventListener("click", save);
$("test").addEventListener("click", async () => {
  const s = read();
  $("testResult").textContent = "Testing…";
  const r = await browser.runtime.sendMessage({ type: "testKey", apiKey: s.apiKey, model: s.model });
  $("testResult").textContent = r.ok ? "Works with " + s.model + "." : r.message;
});
$("export").addEventListener("click", async () => {
  const all = await browser.storage.local.get(null);
  const patches = Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith("patches:")));
  const blob = new Blob([JSON.stringify(patches, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "page-patcher-patches.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$("import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const entries = Object.entries(data).filter(([k, v]) => k.startsWith("patches:") && Array.isArray(v));
    const { validateOp } = globalThis.PagePatcherSchema;
    const existing = await browser.storage.local.get(entries.map(([k]) => k));
    const merged = {};
    for (const [k, list] of entries) {
      const byId = new Map((existing[k] || []).map((p) => [p.id, p]));
      for (const p of list) {
        // Imported patches go through the same validation as model output.
        if (p && typeof p.id === "string" && typeof p.description === "string" && Array.isArray(p.ops) && p.ops.every((op) => !validateOp(op)))
          byId.set(p.id, p);
      }
      merged[k] = Array.from(byId.values());
    }
    await browser.storage.local.set(merged);
    countPatches();
    $("saved").textContent = "Imported.";
  } catch (err) {
    $("saved").textContent = "Import failed: " + err.message;
  }
});

load();
