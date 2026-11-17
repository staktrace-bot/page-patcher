# Page Patcher

A Firefox add-on (Manifest V3, desktop and Android) that changes the page you're on when you describe the change in plain English. An AI model (xAI's Grok, with your own API key) turns the instruction into a small **patch**: a list of operations from a fixed vocabulary that the add-on carries out. Patches can be saved per site and re-apply automatically on later visits.

Things it's for:

- **Paste blocking.** Many sites (Indian banking and government sites in particular) block paste with `onpaste="return false"` or script listeners, which also breaks password-manager autofill. "Let me paste into the password fields" fixes it.
- **Desktop-only layouts on a phone.** "Make this readable on my phone" reflows fixed-width layouts, stacks sidebars, and makes wide tables scroll on their own.
- **Better presentation.** "Show these results as a compact grid with the price first."

Status: prototype (v0.1.0). The model never gets to run JavaScript; see [Op vocabulary](#op-vocabulary).

## Using it

**Desktop.** Click the toolbar button. The popup shows:

- the patches saved for this site, each with a plain-English description, an on/off switch (on means it applies automatically), **Apply now** / **Undo** for a one-off, **Delete**, and a collapsed **Details** view of the ops;
- a prompt box. Type what you want and press **Patch page** (or Ctrl+Enter). The patch is applied right away and its description appears with **Undo** and **Save for this site** (optionally "only on this page"). If it isn't quite right, type a follow-up ("also hide the banner", "that broke the menu") and the model revises the current draft instead of starting over.

There's no code review step; you see what changed on the page, and Undo is one click.

**Android (Firefox Nightly).** The same popup is in the main menu under Extensions → Page Patcher, and it lays out full-width for a phone. Because that's three taps deep, Page Patcher also shows a small floating button on pages (on by default on Android, off by default on desktop; change it in settings). Tapping it opens the same UI as a bottom sheet over the page.

The floating panel is an `<iframe>` of the extension's own `popup.html` inside a closed shadow root, rather than a separate re-implementation of the UI or a new tab:

- it's the same code as the popup, with the full extension API, so the two can't drift apart;
- the page stays visible above the sheet, so you can see the patch take effect, and the active tab stays the page you're patching (which the screenshot needs);
- opening a tab on Android loses the context of the page and makes switching back clumsy.

If a page somehow prevents the frame from loading, the button falls back to opening the UI in a new tab after a few seconds. The trade-off is that `popup.html` has to be listed in `web_accessible_resources`, so pages can detect that the add-on is installed.

**Settings** (Add-ons → Page Patcher → Preferences, opened automatically on first install): xAI API key, model (default `grok-4.7`; `grok-4.20-0309-non-reasoning` is faster and cheaper), when to send a screenshot, the floating button, a **Test key** button, and export/import of saved patches.

## Installing in Nightly

The release zip is unsigned. Pick one:

**Desktop Nightly or Developer Edition**

- *Temporary (any build):* `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `page_patcher-0.1.0.zip` (or `manifest.json` in a checkout). It's removed when Firefox restarts.
- *Persistent unsigned:* set `xpinstall.signatures.required` to `false` in `about:config` (only honored by Nightly, Developer Edition, and unbranded builds), then drag the zip (renamed to `.xpi`) into Firefox or use about:addons → gear → **Install Add-on From File…**.
- *Dev loop:* `npx web-ext run -f nightly` from a checkout reloads on file changes.

**Android Nightly**

- *Signed xpi (recommended):* sign it as **unlisted** on AMO (below), copy the `.xpi` to the phone, then Settings → About Firefox Nightly → tap the logo 5 times → back in Settings, **Install extension from file**.
- *Over adb (development):* enable USB debugging on the phone and remote debugging in Nightly's settings, then `npx web-ext run -t firefox-android --adb-device <device> --firefox-apk org.mozilla.fenix`. This installs it temporarily and reloads on changes.
- *Custom add-on collection:* add the signed add-on to an AMO collection and point Nightly's Settings → **Custom Add-on collection** at it.

### Signing (unlisted) with an AMO account

Through the web: [AMO Developer Hub](https://addons.mozilla.org/developers/) → Submit a New Add-on → **On your own** → upload `page_patcher-0.1.0.zip` → it validates and is usually signed within minutes → download the signed `.xpi` from the version page. The zip contains the readable source, so no separate source upload is needed. Later versions go up as new versions of the same add-on (the ID is `page-patcher@staktrace.com`).

From the command line, with [AMO API keys](https://addons.mozilla.org/developers/addon/api/key/):

```sh
npx web-ext sign --channel unlisted --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
```

The manifest declares `websiteContent` under `data_collection_permissions` because page outlines and screenshots are sent to xAI. Firefox shows this in its install-time consent prompt.

## How it works

```
 popup / in-page panel ──port "generate"──▶ background (event page)
        │                                     │  1. tabs.sendMessage(summarize) ─▶ content script
        │                                     │  2. tabs.captureVisibleTab (layout requests)
        │                                     │  3. POST https://api.x.ai/v1/chat/completions
        │                                     │     (response_format: json_schema, strict)
        │                                     │  4. validate ─▶ tabs.sendMessage(setDraft)
        ▼                                     ▼
 storage.local "patches:<hostname>" ◀──▶ content script: op engine + MutationObserver
```

- **Content script** (`src/content.js`, with `src/ops.js` and `src/summarize.js`) runs in every top-level page at `document_start`. That early start is only so the event guard (below) is registered before any page script; saved patches are applied once the DOM is ready, and the script then keeps them applied with a debounced `MutationObserver`. The observer is disconnected while ops run, so the add-on's own writes never retrigger it, and all ops are idempotent. Path-scoped patches are re-evaluated on SPA navigations.
- **Page summary** (`src/summarize.js`): a text outline of the DOM with tags, ids, classes, and the attributes that matter for patching (`on*` handlers, `autocomplete`, `readonly`, `disabled`, `maxlength`, `style`, `role`, `aria-label`, …), short text snippets, runs of look-alike siblings collapsed ("… 47 more li.row"), elements wider than the viewport and fixed/sticky elements flagged, and scripts, styles, and SVG dropped. Form fields are listed first so they survive truncation. Field values are never included, and link query strings are stripped. The output is capped at 40 KB. The viewport size, device pixel ratio, whether it's mobile, horizontal overflow, and the meta viewport are included.
- **Screenshot**: in "auto" mode (the default) a JPEG of the visible tab is attached when the instruction sounds like layout ("mobile", "layout", "grid", "readable", …). It's skipped when the UI is in its own tab, and dropped automatically if the model rejects image input.
- **Model call** (`src/background.js`, `src/prompt.js`, `src/schema.js`): xAI's OpenAI-compatible chat completions endpoint with a strict JSON schema of the op vocabulary. It falls back to `json_object` if the schema is rejected. Every response is validated again locally: invalid ops are dropped and reported, and if nothing valid is left the model gets one retry with the errors. The system prompt explains the ops, says to prefer CSS, asks for selectors that survive reloads (no generated class names or `:nth-child` chains), tells the model to ignore instructions embedded in the page, and includes worked examples for paste unblocking, mobile reflow, and re-layout.
- **CSS injection** goes through `scripting.insertCSS` / `removeCSS` from the background, because Firefox applies the page's CSP to `<style>` elements created by content scripts. Inline styles are set through CSSOM (`el.style.setProperty(..., "important")`), which CSP doesn't block.
- **Undo**: every op records what it changed (old attribute values, old inline style values and priorities, comment placeholders where removed or moved nodes came from, wrappers, and inserted nodes), and undo replays these in reverse. Removing the injected stylesheet undoes `addCSS`.
- **Storage**: `storage.local` holds `settings` (including the API key) and `patches:<hostname>` → `[{id, description, ops, instruction, enabled, pathPattern, createdAt}]`. `pathPattern` is an optional glob on `location.pathname`.

### Op vocabulary

| op | fields | notes |
| --- | --- | --- |
| `addCSS` | `css` | Preferred for anything visual. No `@import` or remote `url()`; only `data:image` URLs, so CSS can't exfiltrate page data. |
| `setStyle` | `selector`, `props` | Inline styles with `!important`. Original values are restored on undo. |
| `hide` | `selector` | `display: none !important` inline. |
| `remove` | `selector` | Detaches nodes, leaving a comment placeholder for undo. |
| `removeAttribute` | `selector`, `attr` | e.g. `readonly`, `maxlength`, `autocomplete`. |
| `setAttribute` | `selector`, `attr`, `value` | Refuses `on*`, `srcdoc`, and `javascript:`/`data:` URLs. |
| `move` | `selector`, `targetSelector`, `position` | `before` / `after` / `prepend` / `append` relative to the first target. Keeps source order. |
| `wrap` | `selector`, `tag`, `className?`, `style?`, `group?` | One wrapper per element, or one for all matches (`group: true`). |
| `insertHTML` | `selector`, `position`, `html` | Allowlist sanitizer, parsed in an inert `DOMParser` document. Scripts, handlers, forms, inputs, buttons, iframes, SVG, and `<style>` are removed. |
| `unblockEvents` | `selector`, `events` | See below. Events: `paste copy cut contextmenu selectstart dragstart drop keydown beforeinput`. |

**How `unblockEvents` works:** the content script registers capture-phase listeners on `window` at `document_start`, before any page script exists. Capture on `window` is the first stop on every event's path, and listeners there run in registration order, so ours runs first. When an active rule's selector matches the event target (`closest()`), it calls `stopImmediatePropagation()`. The page's `onpaste` attributes and `addEventListener` handlers, on the element, document, or window, never see the event and can't `preventDefault()` it, so the browser's default paste happens. `keydown` is only intercepted for Ctrl/Cmd+V/C/X/A and Shift+Insert, and `beforeinput` only for paste and drop input types, so normal typing is untouched. The matching elements' `on<event>` attributes and page-assigned properties (through `wrappedJSObject`) are also cleared, and restored on undo. For `copy`/`selectstart` it also sets `user-select: text`.

## Permissions

- `<all_urls>` content script and host permission: patches can apply on any site, `scripting.insertCSS` needs host access, and `captureVisibleTab` needs it when the floating button (not the toolbar button) started the request.
- `https://api.x.ai/*`: the model API (covered by `<all_urls>`, but listed for clarity).
- `storage`, `scripting`, `activeTab`. No `tabs` permission.

## Development

```sh
npm install
npm test               # jsdom unit/fixture tests (node:test)
npm run lint           # web-ext lint
npm run build          # web-ext build -> web-ext-artifacts/page_patcher-<version>.zip
XAI_API_KEY=... npm run test:live    # real model call against tests/fixtures/paste-blocked.html
python3 tests/firefox-smoke.py --firefox <path> --geckodriver <path>   # real Firefox, needs selenium
```

- `tests/ops.test.mjs`: apply and undo (back to an identical DOM) for every op, idempotent re-apply, MutationObserver re-application without loops, the sanitizer, and `unblockEvents` against a page with `onpaste="return false"`, a page-assigned `onpaste` property, `addEventListener('paste', e => e.preventDefault())`, a document capture listener, and a Ctrl+V keydown blocker (page scripts run in the jsdom page world).
- `tests/summarize.test.mjs`: field listing, no values or scripts, query-string stripping, sibling collapsing, and the 30/40/50 KB caps on a huge page.
- `tests/schema.test.mjs`: the schema matches the engine vocabulary, validation and dropping of unsafe ops, fenced JSON, empty "can't do this" answers, and that the system prompt's examples validate.
- `tests/firefox-smoke.py`: loads the built zip into headless Firefox Nightly and checks paste unblocking, `addCSS` under a strict `style-src` CSP, the floating button opening the in-page panel (also as a bottom sheet at phone width), the popup listing saved patches and the draft, Save, toggling a patch off (fully undone), and reload behavior.

## Limitations

- Top frame only. Content in iframes and shadow roots can't be targeted.
- Saved patches depend on selectors. When a site redesigns, they may match nothing; the popup says so ("2 of 3 changes didn't match anything").
- Everything must be expressible with the ops. Behavior changes that need script (re-enabling a disabled submit button's logic, or sorting a table by a column) are out of scope; the model says so instead of producing a broken patch.
- `unblockEvents` stops all page listeners for those events on matching elements. That's what you want for paste blocking, but it would also disable a site's legitimate custom paste handling (e.g. rich editors) inside the selector.
- Layout requests are only as good as the outline and screenshot. The model can't see the page's stylesheet rules, just their effects.
- On desktop, closing the popup while a request is running doesn't cancel it. The draft still gets applied and shows when you reopen the popup.
- The API key lives in `storage.local`, unencrypted, like other extension settings.
- Page text, the DOM outline, and (for layout requests) a screenshot are sent to xAI. Field values aren't, but visible text on screen and in the screenshot is.
- Not yet tried on a real Android device. The popup and panel were checked at phone width in desktop Firefox.

## Future work

- **Reuse Firefox's built-in AI chatbot configuration.** The goal is for Page Patcher to use whatever provider the user picked for Firefox's AI chatbot sidebar, so there's nothing to set up twice. Extensions can't read that configuration today. The built-in chatbot loads the provider's website and relies on its login rather than an API key. This needs a new WebExtensions API (for example, a `browser.ai` / `trial.ml`-style API that proxies prompts to the configured provider, or a read-only view of `browser.ml.chat.provider`).
- **`userScripts` escape hatch.** For changes the op vocabulary can't express, Firefox's MV3 `userScripts` API (an optional permission) could run model-written scripts in an isolated `USER_SCRIPT` world, behind an explicit opt-in.
- Feed back per-op match counts automatically and let the model repair selectors that matched nothing.
- iframe and open-shadow-root support; patch scoping by URL pattern in the UI; sharing patches.
- Local models (Firefox's on-device ML) for simple fixes like paste unblocking that don't need a large model.

## License

MIT. See `LICENSE`.
