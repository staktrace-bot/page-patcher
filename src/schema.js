/*
 * The patch format the model must return, as a JSON Schema for xAI structured
 * outputs, plus a validator that is applied to every response regardless.
 * Shared by the background script and the tests.
 */
(function (root) {
  "use strict";

  const BLOCKABLE_EVENTS = ["paste", "copy", "cut", "contextmenu", "selectstart", "dragstart", "drop", "keydown", "beforeinput"];
  const POSITIONS = ["before", "after", "prepend", "append"];
  const WRAP_TAGS = ["div", "section", "aside", "main", "nav", "header", "footer", "article", "details", "span"];
  const MAX_OPS = 40;

  const str = (description, extra = {}) => ({ type: "string", description, ...extra });
  const opSchema = (type, properties, required) => ({
    type: "object",
    properties: { type: { const: type }, ...properties },
    required: ["type", ...required],
    additionalProperties: false,
  });
  const styleMap = {
    type: "object",
    description: "CSS property name (kebab-case) to value, without !important.",
    additionalProperties: { type: "string" },
  };

  const OP_SCHEMAS = [
    opSchema("addCSS", { css: str("A complete stylesheet. Rules are injected as-is; use !important where needed.") }, ["css"]),
    opSchema("removeAttribute", { selector: str("CSS selector"), attr: str("Attribute name") }, ["selector", "attr"]),
    opSchema(
      "setAttribute",
      { selector: str("CSS selector"), attr: str("Attribute name (never on* handlers)"), value: str("New value") },
      ["selector", "attr", "value"]
    ),
    opSchema("hide", { selector: str("CSS selector") }, ["selector"]),
    opSchema("remove", { selector: str("CSS selector") }, ["selector"]),
    opSchema(
      "move",
      {
        selector: str("CSS selector of the elements to move"),
        targetSelector: str("CSS selector of the reference element (first match is used)"),
        position: { type: "string", enum: POSITIONS },
      },
      ["selector", "targetSelector", "position"]
    ),
    opSchema("setStyle", { selector: str("CSS selector"), props: styleMap }, ["selector", "props"]),
    opSchema(
      "unblockEvents",
      {
        selector: str("CSS selector of elements whose events the page should no longer be able to block"),
        events: { type: "array", items: { type: "string", enum: BLOCKABLE_EVENTS }, minItems: 1 },
      },
      ["selector", "events"]
    ),
    opSchema(
      "wrap",
      {
        selector: str("CSS selector of elements to wrap"),
        tag: { type: "string", enum: WRAP_TAGS },
        className: str("Class for the wrapper"),
        style: styleMap,
        group: { type: "boolean", description: "true: wrap all matches together in one wrapper; false: one wrapper each" },
      },
      ["selector", "tag"]
    ),
    opSchema(
      "insertHTML",
      {
        selector: str("CSS selector of reference elements"),
        position: { type: "string", enum: POSITIONS },
        html: str("Static HTML. Scripts, handlers, forms and iframes are stripped."),
      },
      ["selector", "position", "html"]
    ),
  ];

  const RESPONSE_SCHEMA = {
    type: "object",
    properties: {
      description: str("One or two plain-English sentences describing what the patch does, for a non-technical user."),
      ops: { type: "array", items: { anyOf: OP_SCHEMAS }, maxItems: MAX_OPS },
    },
    required: ["description", "ops"],
    additionalProperties: false,
  };

  // -------------------------------------------------------------- validator

  function extractJson(text) {
    if (typeof text !== "string") return text;
    let t = text.trim();
    const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) t = fence[1];
    if (!t.startsWith("{")) {
      const start = t.indexOf("{");
      const end = t.lastIndexOf("}");
      if (start >= 0 && end > start) t = t.slice(start, end + 1);
    }
    return JSON.parse(t);
  }

  function isNonEmptyString(v, max) {
    return typeof v === "string" && v.trim().length > 0 && v.length <= max;
  }

  function badUrl(v) {
    const s = String(v).replace(/[\u0000-\u0020]/g, "").toLowerCase();
    return s.startsWith("javascript:") || s.startsWith("vbscript:") || (s.startsWith("data:") && !s.startsWith("data:image/"));
  }

  function checkStyleMap(m, where) {
    if (!m || typeof m !== "object" || Array.isArray(m)) return where + " must be an object";
    const entries = Object.entries(m);
    if (!entries.length) return where + " is empty";
    if (entries.length > 64) return where + " has too many properties";
    for (const [k, v] of entries) {
      if (!/^-{0,2}[a-zA-Z][-a-zA-Z0-9]*$/.test(k)) return where + " has a bad property name " + k;
      if (typeof v !== "string" && typeof v !== "number") return where + "." + k + " must be a string";
      if (/url\s*\(|expression\s*\(|!important/i.test(String(v))) return where + "." + k + " has a disallowed value";
    }
    return null;
  }

  function validateOp(op) {
    if (!op || typeof op !== "object") return "op is not an object";
    const sel = (k) => (isNonEmptyString(op[k], 2000) ? null : k + " must be a non-empty selector string");
    switch (op.type) {
      case "addCSS":
        if (!isNonEmptyString(op.css, 50000)) return "css must be a non-empty string";
        if (/@import|javascript:|expression\s*\(|-moz-binding/i.test(op.css)) return "css contains a disallowed construct";
        // Remote url() loads could leak page data (e.g. attribute-selector tricks).
        if (/url\s*\(\s*(?!["']?data:image\/)/i.test(op.css)) return "css may only use data:image URLs";
        return null;
      case "removeAttribute":
        return sel("selector") || (isNonEmptyString(op.attr, 100) ? null : "attr required");
      case "setAttribute": {
        const e = sel("selector") || (isNonEmptyString(op.attr, 100) ? null : "attr required");
        if (e) return e;
        if (typeof op.value !== "string") return "value must be a string";
        const a = op.attr.toLowerCase();
        if (a.startsWith("on") || a === "srcdoc") return "setAttribute may not set " + op.attr;
        if (["href", "src", "action", "formaction", "xlink:href", "poster", "srcset", "data"].includes(a) && badUrl(op.value))
          return "unsafe URL";
        return null;
      }
      case "hide":
      case "remove":
        return sel("selector");
      case "move":
        return sel("selector") || sel("targetSelector") || (POSITIONS.includes(op.position) ? null : "bad position");
      case "setStyle":
        return sel("selector") || checkStyleMap(op.props, "props");
      case "unblockEvents":
        if (sel("selector")) return sel("selector");
        if (!Array.isArray(op.events) || !op.events.length) return "events must be a non-empty array";
        for (const ev of op.events) if (!BLOCKABLE_EVENTS.includes(ev)) return "unsupported event " + ev;
        return null;
      case "wrap":
        if (sel("selector")) return sel("selector");
        if (!WRAP_TAGS.includes(op.tag)) return "bad wrap tag";
        if (op.style !== undefined && op.style !== null) return checkStyleMap(op.style, "style");
        return null;
      case "insertHTML":
        return sel("selector") || (POSITIONS.includes(op.position) ? null : "bad position") || (isNonEmptyString(op.html, 50000) ? null : "html required");
      default:
        return "unknown op type " + JSON.stringify(op.type);
    }
  }

  // Returns {ok, patch, errors, dropped}. Invalid ops are dropped; the
  // response is rejected only if it is malformed or no ops survive.
  function validatePatchResponse(input) {
    let obj;
    try {
      obj = extractJson(input);
    } catch (e) {
      return { ok: false, errors: ["Response is not valid JSON: " + e.message], dropped: [] };
    }
    const errors = [];
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, errors: ["Response must be a JSON object"], dropped: [] };
    if (!isNonEmptyString(obj.description, 2000)) errors.push("description must be a non-empty string");
    if (!Array.isArray(obj.ops)) errors.push("ops must be an array");
    if (errors.length) return { ok: false, errors, dropped: [] };
    if (obj.ops.length > MAX_OPS) return { ok: false, errors: ["too many ops (max " + MAX_OPS + ")"], dropped: [] };
    const ops = [];
    const dropped = [];
    obj.ops.forEach((op, i) => {
      const err = validateOp(op);
      if (err) dropped.push({ index: i, error: err, op });
      else ops.push(normalizeOp(op));
    });
    if (!obj.ops.length) {
      // The model is allowed to decline with an explanation and no ops.
      return { ok: true, patch: { description: obj.description.trim(), ops: [] }, errors: [], dropped: [] };
    }
    if (!ops.length) {
      return { ok: false, errors: ["no valid ops" + (dropped.length ? ": " + dropped.map((d) => d.error).join("; ") : "")], dropped };
    }
    return { ok: true, patch: { description: obj.description.trim(), ops }, errors: [], dropped };
  }

  function normalizeOp(op) {
    const out = {};
    for (const [k, v] of Object.entries(op)) {
      if (v === null || v === undefined) continue;
      if (k === "props" || k === "style") {
        out[k] = Object.fromEntries(Object.entries(v).map(([p, val]) => [p, String(val)]));
      } else out[k] = v;
    }
    if (out.type === "wrap") out.group = !!out.group;
    return out;
  }

  const api = { RESPONSE_SCHEMA, OP_SCHEMAS, BLOCKABLE_EVENTS, POSITIONS, WRAP_TAGS, MAX_OPS, validatePatchResponse, validateOp, extractJson };
  root.PagePatcherSchema = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
