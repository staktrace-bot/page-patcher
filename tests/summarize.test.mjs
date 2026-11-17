import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Summarize, dom } from "./helpers.mjs";

const fixture = readFileSync(new URL("./fixtures/paste-blocked.html", import.meta.url), "utf8");

test("summary lists form fields with their blocking handlers, never values or scripts", () => {
  const { document } = dom(fixture);
  const s = Summarize.summarizePage(document, { isMobile: true });
  assert.match(s.text, /Form fields \(3\)/);
  assert.match(s.text, /input#txtPassword\[name="password" type="password" autocomplete="off"\]?[^\n]*onpaste="return false;"/);
  assert.match(s.text, /label="Password"/);
  assert.match(s.text, /mobile=true/);
  assert.doesNotMatch(s.text, /SECRETVALUE/);
  assert.doesNotMatch(s.text, /addEventListener|\.container \{/);
  assert.match(s.text, /div\.right/);
});

test("summary strips query strings from links", () => {
  const { document } = dom('<body><a href="/reset?token=abc123#x">Reset</a></body>');
  const s = Summarize.summarizePage(document);
  assert.match(s.text, /href="\/reset"/);
  assert.doesNotMatch(s.text, /abc123/);
});

test("summary collapses long runs of similar siblings", () => {
  const items = Array.from({ length: 50 }, (_, i) => `<li class="row">Item ${i}</li>`).join("");
  const { document } = dom(`<body><ul id="l">${items}</ul></body>`);
  const s = Summarize.summarizePage(document);
  assert.match(s.text, /… 47 more li\.row/);
  assert.doesNotMatch(s.text, /Item 10/);
});

test("summary respects the size cap on a huge page", () => {
  let html = "<body>";
  for (let i = 0; i < 3000; i++) {
    html += `<div id="d${i}" class="block-${i % 7} variant-${i}"><span class="t${i}">${"lorem ipsum ".repeat(20)}</span><input name="f${i}" onpaste="return false"></div>`;
  }
  html += "</body>";
  const { document } = dom(html);
  for (const max of [30000, 40000, 50000]) {
    const s = Summarize.summarizePage(document, { maxChars: max });
    assert.ok(s.chars <= max, `size ${s.chars} <= ${max}`);
    assert.ok(s.chars > max * 0.8, "uses most of the budget");
    assert.equal(s.truncated, true);
    assert.match(s.text, /truncated/);
  }
});
