/*
 * Page Patcher op engine.
 *
 * A patch is {id, description, ops: [...]}, where every op comes from a fixed
 * vocabulary. This file applies ops to a document, records how to undo them,
 * and re-applies them idempotently when the page changes. It never evaluates
 * code supplied by the model.
 *
 * Loaded as a classic content script (exposes globalThis.PagePatcherOps) and
 * as a CommonJS module in the jsdom tests.
 */
(function (root) {
  "use strict";

  const ROOT_ID = "page-patcher-root";
  const STYLE_ATTR = "data-page-patcher-style";
  const INSERTED_ATTR = "data-page-patcher-inserted";
  const WRAP_ATTR = "data-page-patcher-wrap";
  const MAX_MATCHES = 2000;

  // Events that unblockEvents may stop the page from seeing.
  const BLOCKABLE_EVENTS = [
    "paste",
    "copy",
    "cut",
    "contextmenu",
    "selectstart",
    "dragstart",
    "drop",
    "keydown",
    "beforeinput",
  ];
  const POSITIONS = ["before", "after", "prepend", "append"];
  const WRAP_TAGS = ["div", "section", "aside", "main", "nav", "header", "footer", "article", "details", "span"];

  class OpError extends Error {}

  // ---------------------------------------------------------------- helpers

  function isOurs(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id === ROOT_ID || el.hasAttribute(STYLE_ATTR)) return true;
    return !!(el.closest && el.closest("#" + ROOT_ID));
  }

  function queryAll(doc, selector) {
    let list;
    try {
      list = doc.querySelectorAll(selector);
    } catch (e) {
      throw new OpError("Invalid selector: " + selector);
    }
    const out = [];
    for (const el of list) {
      if (!isOurs(el)) out.push(el);
      if (out.length >= MAX_MATCHES) break;
    }
    return out;
  }

  function kebab(prop) {
    if (prop.startsWith("--")) return prop;
    return prop.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  }

  // In a Firefox content script, element properties go through an Xray
  // wrapper, so page-assigned handlers (el.onpaste = fn) are only visible on
  // wrappedJSObject. In jsdom there is no such wrapper.
  function pageObject(obj) {
    return (obj && obj.wrappedJSObject) || obj;
  }

  function isDangerousUrl(value) {
    const v = String(value).replace(/[\u0000-\u0020]/g, "").toLowerCase();
    return v.startsWith("javascript:") || v.startsWith("vbscript:") || (v.startsWith("data:") && !v.startsWith("data:image/"));
  }

  const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href", "poster", "srcset", "data"]);

  function checkSetAttribute(attr, value) {
    const a = String(attr).toLowerCase();
    if (a.startsWith("on")) throw new OpError("Refusing to set event handler attribute " + attr);
    if (a === "srcdoc") throw new OpError("Refusing to set srcdoc");
    if (URL_ATTRS.has(a) && isDangerousUrl(value)) throw new OpError("Refusing unsafe URL in " + attr);
    if (!/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(attr)) throw new OpError("Invalid attribute name " + attr);
  }

  // ------------------------------------------------------------ sanitizer

  const ALLOWED_TAGS = new Set(
    (
      "a abbr article aside b bdi bdo blockquote br caption cite code col colgroup dd del details dfn div dl dt em " +
      "figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd label li main mark nav ol p pre q s samp " +
      "section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr"
    ).split(" ")
  );
  // Dropped along with their contents.
  const DROP_TAGS = new Set(
    "script style iframe frame frameset object embed applet template noscript form input textarea select option button link meta base svg math audio video source track canvas portal dialog".split(
      " "
    )
  );
  const ALLOWED_ATTRS = new Set(
    "class id title alt href src colspan rowspan style lang dir open datetime width height target role cite start reversed type scope headers".split(" ")
  );

  function sanitizeInto(doc, html) {
    // DOMParser documents are inert: no scripts run and nothing loads.
    const Parser = (doc.defaultView && doc.defaultView.DOMParser) || DOMParser;
    const parsed = new Parser().parseFromString("<!DOCTYPE html><body>" + String(html), "text/html");
    const frag = doc.createDocumentFragment();
    const walk = (parent) => {
      for (const node of Array.from(parent.childNodes)) {
        if (node.nodeType === 3) continue;
        if (node.nodeType !== 1) {
          node.remove();
          continue;
        }
        const tag = node.localName;
        if (DROP_TAGS.has(tag) || node.namespaceURI !== "http://www.w3.org/1999/xhtml") {
          node.remove();
          continue;
        }
        if (!ALLOWED_TAGS.has(tag)) {
          walk(node);
          node.replaceWith(...Array.from(node.childNodes));
          continue;
        }
        for (const attr of Array.from(node.attributes)) {
          const name = attr.name.toLowerCase();
          const ok =
            (ALLOWED_ATTRS.has(name) || name.startsWith("aria-") || name.startsWith("data-")) &&
            !name.startsWith("on") &&
            !(URL_ATTRS.has(name) && isDangerousUrl(attr.value)) &&
            !(name === "style" && /url\s*\(|expression\s*\(/i.test(attr.value));
          if (!ok) node.removeAttribute(attr.name);
        }
        if (tag === "a" && node.hasAttribute("target")) node.setAttribute("rel", "noopener noreferrer");
        walk(node);
      }
    };
    walk(parsed.body);
    for (const node of Array.from(parsed.body.childNodes)) frag.append(doc.importNode(node, true));
    return frag;
  }

  // ---------------------------------------------------------- event guard

  /*
   * A capture-phase listener on window runs before any listener the page can
   * add on document or on the target, as long as ours was registered first
   * (the content script runs at document_start). When a rule matches the
   * event target we stop propagation, so neither on* attributes nor
   * addEventListener handlers get to call preventDefault(). The browser's
   * default action (the actual paste) still happens.
   */
  function createEventGuard(win) {
    const rules = new Set();
    function targetElement(ev) {
      const path = ev.composedPath ? ev.composedPath() : [];
      let t = path.length ? path[0] : ev.target;
      if (t && t.nodeType === 3) t = t.parentElement;
      return t && t.nodeType === 1 ? t : null;
    }
    function relevant(ev) {
      if (ev.type === "keydown") {
        // Only clipboard shortcuts; never swallow ordinary typing.
        const k = (ev.key || "").toLowerCase();
        return ((ev.ctrlKey || ev.metaKey) && ["v", "c", "x", "a"].includes(k)) || (ev.shiftKey && k === "insert");
      }
      if (ev.type === "beforeinput") {
        return /^insertFrom(Paste|Drop)/.test(ev.inputType || "");
      }
      return true;
    }
    function handler(ev) {
      if (!rules.size || !relevant(ev)) return;
      const el = targetElement(ev);
      if (!el) return;
      for (const rule of rules) {
        if (!rule.events.has(ev.type)) continue;
        let hit = false;
        try {
          hit = !!el.closest(rule.selector);
        } catch (e) {
          hit = false;
        }
        if (hit) {
          ev.stopImmediatePropagation();
          return;
        }
      }
    }
    for (const type of BLOCKABLE_EVENTS) win.addEventListener(type, handler, true);
    return {
      addRule(selector, events) {
        const rule = { selector, events: new Set(events) };
        rules.add(rule);
        return rule;
      },
      removeRule(rule) {
        rules.delete(rule);
      },
      get size() {
        return rules.size;
      },
    };
  }

  // ------------------------------------------------------------ op handlers

  function applyStyles(el, props, records) {
    let rec = records.get(el);
    for (const [rawProp, value] of Object.entries(props)) {
      const prop = kebab(rawProp);
      const v = String(value);
      if (el.style.getPropertyValue(prop) === v && el.style.getPropertyPriority(prop) === "important") continue;
      if (!rec) {
        rec = { __attr: el.getAttribute("style") };
        records.set(el, rec);
      }
      if (!(prop in rec)) rec[prop] = [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
      el.style.setProperty(prop, v, "important");
    }
  }

  function undoStyles(records) {
    for (const [el, rec] of records) {
      const { __attr: original, ...props } = rec;
      for (const [prop, [old, prio]] of Object.entries(props)) {
        if (old) el.style.setProperty(prop, old, prio);
        else el.style.removeProperty(prop);
      }
      // If nothing else changed the style meanwhile, restore the exact
      // original attribute text (or its absence).
      const probe = el.ownerDocument.createElement("div");
      if (original !== null) probe.setAttribute("style", original);
      if (probe.style.cssText === el.style.cssText) {
        if (original === null) el.removeAttribute("style");
        else el.setAttribute("style", original);
      }
    }
    records.clear();
  }

  function placeNodes(target, position, nodes) {
    if (position === "append") target.append(...nodes);
    else if (position === "prepend") target.prepend(...nodes);
    else if (position === "before") target.before(...nodes);
    else if (position === "after") target.after(...nodes);
    else throw new OpError("Bad position " + position);
  }

  const HANDLERS = {
    addCSS: {
      // In the extension, ctx.cssInjector routes CSS through
      // scripting.insertCSS (immune to the page's CSP). Without one (tests),
      // fall back to a <style> element.
      apply(ctx, op, st) {
        if (ctx.cssInjector) {
          if (!st.injected) {
            ctx.cssInjector.insert(op.css);
            st.injected = true;
          }
          return 1;
        }
        if (!st.style) {
          st.style = ctx.doc.createElement("style");
          st.style.setAttribute(STYLE_ATTR, ctx.patchId);
          st.style.textContent = op.css;
        }
        if (!st.style.isConnected) (ctx.doc.head || ctx.doc.documentElement).append(st.style);
        return 1;
      },
      undo(ctx, op, st) {
        if (st.injected && ctx.cssInjector) ctx.cssInjector.remove(op.css);
        if (st.style) st.style.remove();
        st.style = null;
        st.injected = false;
      },
    },

    removeAttribute: {
      apply(ctx, op, st) {
        st.records = st.records || new Map();
        const els = queryAll(ctx.doc, op.selector);
        for (const el of els) {
          if (!el.hasAttribute(op.attr)) continue;
          if (!st.records.has(el)) st.records.set(el, el.getAttribute(op.attr));
          el.removeAttribute(op.attr);
        }
        return els.length;
      },
      undo(ctx, op, st) {
        for (const [el, old] of st.records || []) el.setAttribute(op.attr, old);
        st.records = null;
      },
    },

    setAttribute: {
      apply(ctx, op, st) {
        checkSetAttribute(op.attr, op.value);
        st.records = st.records || new Map();
        const els = queryAll(ctx.doc, op.selector);
        for (const el of els) {
          if (el.getAttribute(op.attr) === String(op.value)) continue;
          if (!st.records.has(el)) st.records.set(el, el.getAttribute(op.attr));
          el.setAttribute(op.attr, op.value);
        }
        return els.length;
      },
      undo(ctx, op, st) {
        for (const [el, old] of st.records || []) {
          if (old === null) el.removeAttribute(op.attr);
          else el.setAttribute(op.attr, old);
        }
        st.records = null;
      },
    },

    setStyle: {
      apply(ctx, op, st) {
        st.records = st.records || new Map();
        const els = queryAll(ctx.doc, op.selector);
        for (const el of els) applyStyles(el, op.props, st.records);
        return els.length;
      },
      undo(ctx, op, st) {
        if (st.records) undoStyles(st.records);
        st.records = null;
      },
    },

    hide: {
      apply(ctx, op, st) {
        return HANDLERS.setStyle.apply(ctx, { selector: op.selector, props: { display: "none" } }, st);
      },
      undo(ctx, op, st) {
        HANDLERS.setStyle.undo(ctx, op, st);
      },
    },

    remove: {
      apply(ctx, op, st) {
        st.records = st.records || new Map(); // el -> placeholder comment
        const els = queryAll(ctx.doc, op.selector);
        for (const el of els) {
          if (!st.records.has(el)) {
            const ph = ctx.doc.createComment("page-patcher removed");
            el.before(ph);
            st.records.set(el, ph);
          }
          el.remove();
        }
        return els.length;
      },
      undo(ctx, op, st) {
        const entries = Array.from(st.records || []).reverse();
        for (const [el, ph] of entries) {
          if (ph.isConnected) ph.replaceWith(el);
        }
        st.records = null;
      },
    },

    move: {
      apply(ctx, op, st) {
        st.records = st.records || new Map(); // el -> placeholder
        const targets = queryAll(ctx.doc, op.targetSelector);
        if (!targets.length) return 0;
        const target = targets[0];
        const els = queryAll(ctx.doc, op.selector).filter(
          (el) => el !== target && !el.contains(target) && !(st.records.has(el) && el.isConnected)
        );
        if (!els.length) return st.records.size;
        for (const el of els) {
          const ph = ctx.doc.createComment("page-patcher moved");
          el.before(ph);
          st.records.set(el, ph);
        }
        if (op.position === "after") {
          // Keep source order when inserting several nodes after the target.
          let ref = target;
          for (const el of els) {
            ref.after(el);
            ref = el;
          }
        } else {
          placeNodes(target, op.position, els);
        }
        return st.records.size;
      },
      undo(ctx, op, st) {
        const entries = Array.from(st.records || []).reverse();
        for (const [el, ph] of entries) {
          if (ph.isConnected) ph.replaceWith(el);
          else el.remove();
        }
        st.records = null;
      },
    },

    wrap: {
      apply(ctx, op, st) {
        const tag = WRAP_TAGS.includes(op.tag) ? op.tag : "div";
        const make = () => {
          const w = ctx.doc.createElement(tag);
          w.setAttribute(WRAP_ATTR, ctx.patchId);
          if (op.className) w.className = op.className;
          if (op.style) applyStyles(w, op.style, new Map());
          return w;
        };
        const els = queryAll(ctx.doc, op.selector).filter((el) => !el.closest("[" + WRAP_ATTR + '="' + ctx.patchId + '"]'));
        if (op.group) {
          st.placeholders = st.placeholders || new Map();
          if (!els.length) return st.placeholders.size;
          if (!st.wrapper || !st.wrapper.isConnected) {
            st.wrapper = st.wrapper || make();
            els[0].before(st.wrapper);
          }
          for (const el of els) {
            const ph = ctx.doc.createComment("page-patcher wrapped");
            el.before(ph);
            st.placeholders.set(el, ph);
            st.wrapper.append(el);
          }
          return st.placeholders.size;
        }
        st.wrappers = st.wrappers || [];
        for (const el of els) {
          const w = make();
          el.before(w);
          w.append(el);
          st.wrappers.push(w);
        }
        return st.wrappers.length;
      },
      undo(ctx, op, st) {
        if (st.placeholders) {
          for (const [el, ph] of Array.from(st.placeholders).reverse()) {
            if (ph.isConnected) ph.replaceWith(el);
          }
          if (st.wrapper) st.wrapper.replaceWith(...Array.from(st.wrapper.childNodes));
        }
        for (const w of (st.wrappers || []).reverse()) {
          if (w.isConnected) w.replaceWith(...Array.from(w.childNodes));
        }
        st.placeholders = st.wrapper = st.wrappers = null;
      },
    },

    insertHTML: {
      apply(ctx, op, st) {
        st.inserted = st.inserted || new Map(); // target -> nodes
        const els = queryAll(ctx.doc, op.selector).slice(0, 50);
        for (const el of els) {
          if (st.inserted.has(el)) continue;
          const frag = sanitizeInto(ctx.doc, op.html);
          const nodes = Array.from(frag.childNodes);
          for (const n of nodes) if (n.nodeType === 1) n.setAttribute(INSERTED_ATTR, ctx.patchId);
          placeNodes(el, op.position || "append", nodes);
          st.inserted.set(el, nodes);
        }
        return els.length;
      },
      undo(ctx, op, st) {
        for (const nodes of (st.inserted || new Map()).values()) for (const n of nodes) n.remove();
        st.inserted = null;
      },
    },

    unblockEvents: {
      apply(ctx, op, st) {
        if (!st.rule && ctx.guard) st.rule = ctx.guard.addRule(op.selector, op.events);
        st.attrs = st.attrs || new Map(); // el -> {onpaste: "return false"}
        st.props = st.props || new Map(); // el -> {onpaste: fn}
        st.styles = st.styles || new Map();
        const els = queryAll(ctx.doc, op.selector);
        for (const el of els) {
          for (const type of op.events) {
            const name = "on" + type;
            if (el.hasAttribute(name)) {
              const rec = st.attrs.get(el) || {};
              if (!(name in rec)) rec[name] = el.getAttribute(name);
              st.attrs.set(el, rec);
              el.removeAttribute(name);
            }
            const raw = pageObject(el);
            let current = null;
            try {
              current = raw[name];
            } catch (e) {
              current = null;
            }
            if (current) {
              const rec = st.props.get(el) || {};
              if (!(name in rec)) rec[name] = current;
              st.props.set(el, rec);
              try {
                raw[name] = null;
              } catch (e) {
                /* ignore */
              }
            }
          }
          if (op.events.includes("selectstart") || op.events.includes("copy")) {
            applyStyles(el, { "user-select": "text", "-webkit-user-select": "text" }, st.styles);
          }
        }
        return els.length;
      },
      undo(ctx, op, st) {
        if (st.rule && ctx.guard) ctx.guard.removeRule(st.rule);
        for (const [el, rec] of st.props || []) {
          const raw = pageObject(el);
          for (const [name, fn] of Object.entries(rec)) {
            try {
              raw[name] = fn;
            } catch (e) {
              /* ignore */
            }
          }
        }
        for (const [el, rec] of st.attrs || []) {
          for (const [name, value] of Object.entries(rec)) el.setAttribute(name, value);
        }
        if (st.styles) undoStyles(st.styles);
        st.rule = st.attrs = st.props = st.styles = null;
      },
    },
  };

  // --------------------------------------------------------------- runners

  function createPatchRunner(doc, patch, options = {}) {
    const ctx = {
      doc,
      guard: options.guard || null,
      cssInjector: options.cssInjector || null,
      patchId: String(patch.id || "draft"),
    };
    let states = patch.ops.map(() => ({}));
    let active = false;
    let lastResults = [];
    return {
      patch,
      get active() {
        return active;
      },
      get results() {
        return lastResults;
      },
      apply() {
        active = true;
        lastResults = patch.ops.map((op, i) => {
          const h = HANDLERS[op.type];
          if (!h) return { type: op.type, matches: 0, error: "Unknown op type" };
          try {
            return { type: op.type, matches: h.apply(ctx, op, states[i]) };
          } catch (e) {
            return { type: op.type, matches: 0, error: e.message };
          }
        });
        return lastResults;
      },
      undo() {
        for (let i = patch.ops.length - 1; i >= 0; i--) {
          const h = HANDLERS[patch.ops[i].type];
          try {
            if (h) h.undo(ctx, patch.ops[i], states[i]);
          } catch (e) {
            /* best effort */
          }
        }
        states = patch.ops.map(() => ({}));
        active = false;
      },
    };
  }

  /*
   * Keeps a set of runners applied. Re-applies (debounced) when the page
   * mutates, with the observer disconnected while we write so our own
   * changes never retrigger it.
   */
  function createPatchController(doc, options = {}) {
    const guard = options.guard || null;
    const cssInjector = options.cssInjector || null;
    const delay = options.debounceMs ?? 300;
    const win = doc.defaultView;
    const runners = new Map();
    let timer = null;
    let observer = null;

    function attributeFilter() {
      const attrs = new Set(["class", "id"]);
      for (const r of runners.values()) {
        for (const op of r.patch.ops) {
          if (op.attr) attrs.add(op.attr);
          if (["setStyle", "hide", "unblockEvents"].includes(op.type)) attrs.add("style");
          if (op.type === "unblockEvents") for (const t of op.events) attrs.add("on" + t);
        }
      }
      return Array.from(attrs);
    }

    function observe() {
      if (!observer || !runners.size) return;
      observer.observe(doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: attributeFilter(),
      });
    }

    function withObserverOff(fn) {
      if (observer) observer.disconnect();
      try {
        return fn();
      } finally {
        if (observer) observer.takeRecords();
        observe();
      }
    }

    function schedule() {
      if (timer) return;
      timer = win.setTimeout(() => {
        timer = null;
        if (options.onBeforeReapply) options.onBeforeReapply();
        reapplyAll();
      }, delay);
    }

    if (win && win.MutationObserver) observer = new win.MutationObserver(schedule);

    function reapplyAll() {
      return withObserverOff(() => {
        for (const r of runners.values()) r.apply();
      });
    }

    return {
      runners,
      add(patch) {
        const existing = runners.get(patch.id);
        if (existing) existing.undo();
        const runner = createPatchRunner(doc, patch, { guard, cssInjector });
        runners.set(patch.id, runner);
        return withObserverOff(() => runner.apply());
      },
      adopt(id, runner) {
        runners.set(id, runner);
        withObserverOff(() => {});
      },
      remove(id) {
        const runner = runners.get(id);
        if (!runner) return false;
        runners.delete(id);
        withObserverOff(() => runner.undo());
        return true;
      },
      has(id) {
        return runners.has(id);
      },
      results(id) {
        const r = runners.get(id);
        return r ? r.results : null;
      },
      reapplyAll,
      flush() {
        if (timer) {
          win.clearTimeout(timer);
          timer = null;
        }
        reapplyAll();
      },
    };
  }

  const api = {
    ROOT_ID,
    BLOCKABLE_EVENTS,
    POSITIONS,
    WRAP_TAGS,
    OP_TYPES: Object.keys(HANDLERS),
    OpError,
    createEventGuard,
    createPatchRunner,
    createPatchController,
    sanitizeInto,
    checkSetAttribute,
  };
  root.PagePatcherOps = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
