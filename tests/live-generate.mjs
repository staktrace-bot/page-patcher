// Live end-to-end check against the real xAI API (skipped without a key):
// summarize the fixture, ask the model for a paste-unblocking patch, validate
// it, apply it in jsdom, and confirm paste works.
//   XAI_API_KEY=... [XAI_MODEL=grok-4.7] npm run test:live
import { readFileSync } from "node:fs";
import { Ops, Schema, Summarize, Prompt, dom, paste } from "./helpers.mjs";

const key = process.env.XAI_API_KEY;
if (!key) {
  console.log("SKIP: XAI_API_KEY is not set; live generation test not run.");
  process.exit(0);
}
const model = process.env.XAI_MODEL || "grok-4.7";
const html = readFileSync(new URL("./fixtures/paste-blocked.html", import.meta.url), "utf8");

// Page world: run the fixture's scripts, but install our guard first, as the
// document_start content script would.
const env = dom("<!DOCTYPE html><html><head></head><body></body></html>", { runScripts: "dangerously" });
const guard = Ops.createEventGuard(env.window);
const parsed = dom(html);
env.document.title = parsed.document.title;
env.document.body.innerHTML = parsed.document.body.innerHTML.replace(/<script>[\s\S]*?<\/script>/, "");
env.window.eval(parsed.document.querySelector("script").textContent.replace(/alert\([^)]*\);?/, ""));

const pw = env.document.getElementById("txtPassword");
if (!paste(env.window, pw)) throw new Error("fixture should block paste before patching");

const summary = Summarize.summarizePage(env.document, { isMobile: false }).text;
const instruction = "This site won't let me paste my user ID and password, and my password manager can't fill them. Fix that.";
const t0 = Date.now();
const res = await fetch("https://api.x.ai/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
  body: JSON.stringify({
    model,
    messages: Prompt.buildMessages({ instruction, summary }),
    response_format: { type: "json_schema", json_schema: { name: "page_patch", schema: Schema.RESPONSE_SCHEMA, strict: true } },
  }),
});
const body = await res.text();
if (!res.ok) throw new Error("API " + res.status + ": " + body.slice(0, 500));
const content = JSON.parse(body).choices[0].message.content;
console.log("Model:", model, "latency:", Date.now() - t0, "ms");
console.log("Raw:", content);
const v = Schema.validatePatchResponse(content);
if (!v.ok) throw new Error("invalid patch: " + v.errors.join("; "));
if (v.dropped.length) console.log("Dropped ops:", JSON.stringify(v.dropped));

const runner = Ops.createPatchRunner(env.document, { id: "live", ...v.patch }, { guard });
console.log("Results:", JSON.stringify(runner.apply()));
const ok = ["txtUserId", "txtPassword"].every((id) => !paste(env.window, env.document.getElementById(id)));
console.log("Description:", v.patch.description);
console.log(ok ? "PASS: paste now works on both fields" : "FAIL: paste still blocked");
process.exit(ok ? 0 : 1);
