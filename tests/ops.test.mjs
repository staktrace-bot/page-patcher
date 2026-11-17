import test from "node:test";
import assert from "node:assert/strict";
import { Ops, dom, paste, sleep } from "./helpers.mjs";

const BASE = `
<div id="app">
  <header class="top" style="color: red">Header</header>
  <aside class="sidebar" style="width: 300px">Side</aside>
  <main class="content">
    <p class="ad">Ad 1</p>
    <p class="msg">Hello</p>
    <ul id="list"><li class="item">A</li><li class="item">B</li><li class="item">C</li></ul>
  </main>
  <form id="login"><input id="pw" type="password" readonly autocomplete="off" maxlength="8"></form>
</div>`;

// Attribute order isn't meaningful; compare a canonical serialization.
function canon(node) {
  if (node.nodeType === 3) return node.data;
  if (node.nodeType === 8) return "<!--" + node.data + "-->";
  const attrs = Array.from(node.attributes || [], (a) => a.name + '="' + a.value + '"').sort().join(" ");
  return "<" + node.localName + (attrs ? " " + attrs : "") + ">" + Array.from(node.childNodes, canon).join("") + "</" + node.localName + ">";
}

function setup() {
  const env = dom("<!DOCTYPE html><html><head></head><body>" + BASE + "</body></html>");
  const before = canon(env.document.body);
  return { ...env, before };
}

function roundTrip(ops, check) {
  const { document, window, before } = setup();
  const guard = Ops.createEventGuard(window);
  const runner = Ops.createPatchRunner(document, { id: "t1", description: "t", ops }, { guard });
  const results = runner.apply();
  for (const r of results) assert.equal(r.error, undefined, "op error: " + r.error);
  check(document, window, results);
  // Applying again must be idempotent.
  runner.apply();
  check(document, window, results);
  runner.undo();
  assert.equal(canon(document.body), before, "undo restores the original DOM");
  assert.equal(document.querySelectorAll("style").length, 0);
  return results;
}

test("addCSS injects a stylesheet and undo removes it", () => {
  roundTrip([{ type: "addCSS", css: ".sidebar { display: none !important; }" }], (doc, win) => {
    assert.equal(doc.querySelectorAll("style[data-page-patcher-style]").length, 1);
    assert.equal(win.getComputedStyle(doc.querySelector(".sidebar")).display, "none");
  });
});

test("addCSS uses the css injector when provided", () => {
  const { document } = setup();
  const calls = [];
  const inj = { insert: (c) => calls.push(["insert", c]), remove: (c) => calls.push(["remove", c]) };
  const r = Ops.createPatchRunner(document, { id: "x", ops: [{ type: "addCSS", css: "p{}" }] }, { cssInjector: inj });
  r.apply();
  r.apply();
  r.undo();
  assert.deepEqual(calls, [["insert", "p{}"], ["remove", "p{}"]]);
  assert.equal(document.querySelectorAll("style").length, 0);
});

test("removeAttribute and undo", () => {
  roundTrip([{ type: "removeAttribute", selector: "#pw", attr: "readonly" }], (doc) => {
    assert.equal(doc.querySelector("#pw").hasAttribute("readonly"), false);
  });
});

test("setAttribute (new and existing) and undo", () => {
  roundTrip(
    [
      { type: "setAttribute", selector: "#pw", attr: "autocomplete", value: "current-password" },
      { type: "setAttribute", selector: "#pw", attr: "inputmode", value: "text" },
    ],
    (doc) => {
      assert.equal(doc.querySelector("#pw").getAttribute("autocomplete"), "current-password");
      assert.equal(doc.querySelector("#pw").getAttribute("inputmode"), "text");
    }
  );
});

test("setAttribute refuses event handlers and javascript: URLs", () => {
  const { document } = setup();
  const r = Ops.createPatchRunner(document, {
    id: "x",
    ops: [
      { type: "setAttribute", selector: "#pw", attr: "onfocus", value: "alert(1)" },
      { type: "setAttribute", selector: "header", attr: "href", value: "javascript:alert(1)" },
    ],
  });
  const res = r.apply();
  assert.ok(res[0].error && res[1].error);
  assert.equal(document.querySelector("#pw").hasAttribute("onfocus"), false);
});

test("hide and undo (preserves existing inline style)", () => {
  roundTrip([{ type: "hide", selector: ".top" }], (doc) => {
    const h = doc.querySelector(".top");
    assert.equal(h.style.getPropertyValue("display"), "none");
    assert.equal(h.style.getPropertyPriority("display"), "important");
    assert.equal(h.style.getPropertyValue("color"), "red");
  });
});

test("setStyle overrides an inline property and undo restores it", () => {
  roundTrip([{ type: "setStyle", selector: ".sidebar", props: { width: "auto", "float": "none", maxWidth: "100%" } }], (doc) => {
    const s = doc.querySelector(".sidebar").style;
    assert.equal(s.getPropertyValue("width"), "auto");
    assert.equal(s.getPropertyValue("max-width"), "100%");
  });
});

test("remove and undo puts elements back in place", () => {
  roundTrip([{ type: "remove", selector: ".ad, .msg" }], (doc) => {
    assert.equal(doc.querySelectorAll(".ad").length, 0);
    assert.equal(doc.querySelectorAll(".msg").length, 0);
    assert.equal(doc.querySelectorAll(".item").length, 3);
  });
});

for (const position of ["before", "after", "prepend", "append"]) {
  test("move " + position + " keeps order and undo restores", () => {
    roundTrip([{ type: "move", selector: ".item", targetSelector: ".msg", position }], (doc) => {
      const msg = doc.querySelector(".msg");
      const texts = (nodes) => Array.from(nodes, (e) => e.textContent);
      if (position === "before") assert.deepEqual(texts([msg.previousElementSibling.previousElementSibling.previousElementSibling, msg.previousElementSibling.previousElementSibling, msg.previousElementSibling]), ["A", "B", "C"]);
      if (position === "after") assert.deepEqual(texts([msg.nextElementSibling, msg.nextElementSibling.nextElementSibling, msg.nextElementSibling.nextElementSibling.nextElementSibling]), ["A", "B", "C"]);
      if (position === "append" || position === "prepend") assert.deepEqual(texts(msg.querySelectorAll(".item")), ["A", "B", "C"]);
      assert.equal(doc.querySelector("#list").children.length, 0);
    });
  });
}

test("move sidebar after content (mobile reflow)", () => {
  roundTrip([{ type: "move", selector: ".sidebar", targetSelector: ".content", position: "after" }], (doc) => {
    assert.equal(doc.querySelector(".content").nextElementSibling.className, "sidebar");
  });
});

test("wrap each and undo", () => {
  roundTrip([{ type: "wrap", selector: ".item", tag: "div", className: "card", style: { padding: "4px" } }], (doc) => {
    assert.equal(doc.querySelectorAll("div.card > li.item").length, 3);
  });
});

test("wrap group and undo", () => {
  roundTrip([{ type: "wrap", selector: ".msg, .ad", tag: "section", className: "grid", group: true }], (doc) => {
    const w = doc.querySelector("section.grid");
    assert.ok(w);
    assert.equal(w.children.length, 2);
  });
});

test("insertHTML is sanitized and undo removes it", () => {
  roundTrip(
    [
      {
        type: "insertHTML",
        selector: "#list",
        position: "before",
        html: '<h2 onclick="x()">Summary</h2><script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">bad</a><a href="/ok" target="_blank">ok</a><iframe src="https://evil"></iframe><custom-el><b>kept</b></custom-el>',
      },
    ],
    (doc) => {
      const main = doc.querySelector("main").innerHTML;
      assert.match(main, /<h2 data-page-patcher-inserted="t1">Summary<\/h2>/);
      assert.doesNotMatch(main, /script|onerror|onclick|javascript:|iframe|custom-el/);
      assert.match(main, /<b[^>]*>kept<\/b>/);
      assert.match(main, /rel="noopener noreferrer"/);
    }
  );
});

test("unblockEvents makes paste work despite onpaste attribute, property, and listeners", () => {
  const env = dom("<!DOCTYPE html><html><head></head><body></body></html>", { runScripts: "dangerously" });
  const { window, document } = env;
  // The content script runs at document_start, before any page script.
  const guard = Ops.createEventGuard(window);
  document.body.innerHTML = `
    <form><input id="a" type="password" onpaste="return false" oncopy="return false">
    <input id="b" type="text"><textarea id="c"></textarea></form><input id="other">`;
  // Page scripts, running in the page's own world.
  window.eval(`
    document.getElementById("b").onpaste = function () { return false; };
    document.getElementById("c").addEventListener("paste", (e) => e.preventDefault());
    document.addEventListener("paste", (e) => { if (e.target.id === "other") e.preventDefault(); }, true);
    window.keyBlocked = 0;
    document.addEventListener("keydown", (e) => { if (e.ctrlKey && e.key === "v") { e.preventDefault(); window.keyBlocked++; } });
    window.keysSeen = 0;
    document.addEventListener("keydown", () => window.keysSeen++);
  `);
  const $ = (id) => document.getElementById(id);
  for (const id of ["a", "b", "c", "other"]) assert.equal(paste(window, $(id)), true, id + " blocked before patch");

  const runner = Ops.createPatchRunner(
    document,
    { id: "u", ops: [{ type: "unblockEvents", selector: "form input, form textarea", events: ["paste", "copy", "keydown"] }] },
    { guard }
  );
  runner.apply();
  for (const id of ["a", "b", "c"]) assert.equal(paste(window, $(id)), false, id + " pastes after patch");
  assert.equal(paste(window, $("other")), true, "non-matching field is untouched");
  assert.equal($("a").hasAttribute("onpaste"), false);

  const ctrlV = new window.KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
  $("a").dispatchEvent(ctrlV);
  assert.equal(ctrlV.defaultPrevented, false, "Ctrl+V not blocked");
  const plain = new window.KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
  $("a").dispatchEvent(plain);
  assert.equal(window.keysSeen, 1, "ordinary keys still reach the page");

  runner.undo();
  assert.equal($("a").getAttribute("onpaste"), "return false");
  for (const id of ["a", "b", "c"]) assert.equal(paste(window, $(id)), true, id + " blocked again after undo");
});

test("controller re-applies on DOM mutations without looping", async () => {
  const { document, window } = setup();
  const c = Ops.createPatchController(document, { debounceMs: 20 });
  c.add({ id: "p", description: "", ops: [{ type: "hide", selector: ".ad" }, { type: "removeAttribute", selector: "input", attr: "readonly" }] });
  let applies = 0;
  const runner = c.runners.get("p");
  const orig = runner.apply;
  runner.apply = () => {
    applies++;
    return orig();
  };
  const p = document.createElement("p");
  p.className = "ad";
  document.querySelector("main").append(p);
  document.querySelector("#pw").setAttribute("readonly", "");
  await sleep(150);
  assert.equal(p.style.getPropertyValue("display"), "none");
  assert.equal(document.querySelector("#pw").hasAttribute("readonly"), false);
  const settled = applies;
  await sleep(150);
  assert.equal(applies, settled, "no self-triggered re-apply loop");
  assert.ok(settled >= 1 && settled <= 2);
  c.remove("p");
  assert.equal(p.style.getPropertyValue("display"), "");
  assert.equal(document.querySelector("#pw").getAttribute("readonly"), "");
});

test("invalid selectors are reported, not thrown", () => {
  const { document } = setup();
  const r = Ops.createPatchRunner(document, { id: "x", ops: [{ type: "hide", selector: "div[" }, { type: "hide", selector: ".ad" }] });
  const res = r.apply();
  assert.match(res[0].error, /Invalid selector/);
  assert.equal(res[1].matches, 1);
});

test("ops never touch the extension's own UI", () => {
  const { document } = setup();
  const host = document.createElement("div");
  host.id = Ops.ROOT_ID;
  document.body.append(host);
  const r = Ops.createPatchRunner(document, { id: "x", ops: [{ type: "remove", selector: "div" }] });
  r.apply();
  assert.ok(host.isConnected);
});
