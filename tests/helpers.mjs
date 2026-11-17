import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
export const Ops = require("../src/ops.js");
export const Schema = require("../src/schema.js");
export const Summarize = require("../src/summarize.js");
export const Prompt = require("../src/prompt.js");

export function dom(html = "<!DOCTYPE html><html><head></head><body></body></html>", opts = {}) {
  const jsdom = new JSDOM(html, { url: "https://example.in/login", pretendToBeVisual: true, ...opts });
  return { jsdom, window: jsdom.window, document: jsdom.window.document };
}

export function paste(window, el) {
  const ev = new window.Event("paste", { bubbles: true, cancelable: true, composed: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
