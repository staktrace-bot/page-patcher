/*
 * Builds a compact text outline of the page for the model: tags, ids,
 * classes, a few relevant attributes, short text snippets, a list of form
 * fields, and viewport facts. Never includes field values, scripts, styles
 * or SVG. Output is capped at maxChars.
 */
(function (root) {
  "use strict";

  const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "math", "link", "meta", "head", "canvas", "object", "embed", "path"]);
  const KEEP_ATTRS = [
    "name", "type", "role", "aria-label", "placeholder", "autocomplete", "inputmode", "readonly", "disabled",
    "maxlength", "contenteditable", "draggable", "hidden", "href", "src", "alt", "for", "width", "height",
    "colspan", "style", "data-testid",
  ];
  const ROOT_ID = "page-patcher-root";
  const FIELD_SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

  function clip(s, n) {
    s = String(s).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  function quote(v) {
    return JSON.stringify(v);
  }

  function signature(el) {
    return el.localName + (el.classList.length ? "." + Array.from(el.classList).slice(0, 3).join(".") : "");
  }

  function describe(el, opts) {
    let s = el.localName;
    if (el.id) s += "#" + clip(el.id, 60);
    const classes = Array.from(el.classList).slice(0, 6);
    if (classes.length) s += "." + classes.map((c) => clip(c, 40)).join(".");
    if (el.classList.length > 6) s += ".…";
    const attrs = [];
    for (const a of KEEP_ATTRS) {
      if (!el.hasAttribute(a)) continue;
      if (a === "type" && el.localName !== "input" && el.localName !== "button") continue;
      let v = el.getAttribute(a);
      // Query strings often carry session tokens; the path is enough.
      if (a === "href" || a === "src") v = v.split(/[?#]/)[0];
      const max = a === "style" ? 120 : a === "href" || a === "src" ? 80 : 60;
      attrs.push(v === "" ? a : a + "=" + quote(clip(v, max)));
    }
    for (const attr of el.attributes) {
      if (/^on/i.test(attr.name)) attrs.push(attr.name + "=" + quote(clip(attr.value, 60)));
    }
    if (attrs.length) s += "[" + attrs.join(" ") + "]";
    if (opts && opts.layout) s += opts.layout;
    return s;
  }

  function ownText(el) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.data;
    return t.replace(/\s+/g, " ").trim();
  }

  function layoutNote(el, win, depth, budget) {
    if (!win || depth > 8 || budget.layoutCalls <= 0) return "";
    budget.layoutCalls--;
    let note = "";
    try {
      const r = el.getBoundingClientRect();
      if (r.width > win.innerWidth + 4) note += " {w=" + Math.round(r.width) + "px}";
      const cs = win.getComputedStyle(el);
      if (cs.position === "fixed" || cs.position === "sticky") note += " {" + cs.position + "}";
      if (cs.display === "none") note += " {display:none}";
    } catch (e) {
      /* ignore */
    }
    return note;
  }

  function summarizePage(doc, options = {}) {
    const maxChars = options.maxChars || 40000;
    const win = doc.defaultView;
    const head = [];
    const loc = doc.location || {};
    head.push("URL: " + clip((loc.origin || "") + (loc.pathname || ""), 200));
    head.push("Title: " + clip(doc.title || "", 150));
    if (win) {
      const mobile = !!options.isMobile;
      const sw = doc.documentElement ? doc.documentElement.scrollWidth : 0;
      head.push(
        "Viewport: " + win.innerWidth + "x" + win.innerHeight + " devicePixelRatio=" + (win.devicePixelRatio || 1) +
          " mobile=" + mobile + " documentScrollWidth=" + sw + (sw > win.innerWidth + 4 ? " (page scrolls horizontally)" : "")
      );
    }
    const vp = doc.querySelector("meta[name=viewport]");
    head.push("Meta viewport: " + (vp ? quote(clip(vp.getAttribute("content") || "", 120)) : "none"));

    // Form fields first: they are what paste/autofill requests are about,
    // and they must not be lost to truncation of a long outline.
    const fields = Array.from(doc.querySelectorAll(FIELD_SELECTOR)).filter((el) => !el.closest("#" + ROOT_ID));
    const fieldLines = [];
    for (const el of fields.slice(0, 80)) {
      const form = el.closest("form");
      let label = "";
      if (el.id) {
        try {
          const l = doc.querySelector('label[for="' + el.id.replace(/["\\]/g, "\\$&") + '"]');
          if (l) label = clip(l.textContent, 50);
        } catch (e) {
          /* ignore */
        }
      }
      if (!label && el.closest("label")) label = clip(el.closest("label").textContent, 50);
      fieldLines.push(
        "  " + describe(el) + (label ? " label=" + quote(label) : "") + (form ? " in " + describe(form).slice(0, 120) : "")
      );
    }
    if (fields.length > 80) fieldLines.push("  … " + (fields.length - 80) + " more fields");

    let out = head.join("\n") + "\n\nForm fields (" + fields.length + "):\n" + (fieldLines.join("\n") || "  none") + "\n\nDOM outline:\n";
    // The form section is capped at a fraction of the budget.
    if (out.length > maxChars * 0.4) out = out.slice(0, Math.floor(maxChars * 0.4)) + "\n  …\n\nDOM outline:\n";

    const budget = { layoutCalls: 1500 };
    const lines = [];
    let used = out.length;
    let truncated = false;
    const limit = maxChars - 40;

    function emit(line) {
      if (used + line.length + 1 > limit) {
        truncated = true;
        return false;
      }
      lines.push(line);
      used += line.length + 1;
      return true;
    }

    function walk(el, depth) {
      if (truncated) return;
      const tag = el.localName;
      if (SKIP_TAGS.has(tag) || el.id === ROOT_ID) return;
      const indent = "  ".repeat(Math.min(depth, 30));
      let line = indent + describe(el, { layout: layoutNote(el, win, depth, budget) });
      const text = ownText(el);
      if (text) line += " " + quote(clip(text, 80));
      if (tag === "iframe") line += " (iframe, contents not shown)";
      if (el.shadowRoot) line += " (shadow root, contents not targetable)";
      if (!emit(line.slice(0, 400))) return;
      if (tag === "iframe" || depth > 40) return;

      const kids = Array.from(el.children).filter((k) => !SKIP_TAGS.has(k.localName));
      // Collapse long runs of look-alike siblings (list items, table rows, cards).
      let i = 0;
      while (i < kids.length && !truncated) {
        const sig = signature(kids[i]);
        let j = i;
        while (j < kids.length && signature(kids[j]) === sig) j++;
        const run = j - i;
        const show = run > 6 ? 3 : run;
        for (let k = i; k < i + show; k++) walk(kids[k], depth + 1);
        if (run > show && !truncated) emit(indent + "  … " + (run - show) + " more " + sig);
        i = j;
      }
    }

    if (doc.body) walk(doc.body, 0);
    out += lines.join("\n");
    if (truncated) out += "\n[outline truncated at size limit]";
    return { text: out, truncated, chars: out.length, fieldCount: fields.length };
  }

  const api = { summarizePage };
  root.PagePatcherSummarize = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
