"""
Real-browser smoke test. Loads the built add-on into Firefox (headless) as a
temporary add-on and checks: the content script and paste unblocking, CSS
injection under a strict CSP (scripting.insertCSS), the floating button and
in-page panel, the popup UI (opened in a tab), saving a draft, toggling a
saved patch off, and the missing-key error.

  pip install selenium
  npx web-ext build --overwrite-dest
  python3 tests/firefox-smoke.py --firefox /path/to/firefox --geckodriver /path/to/geckodriver

Marionette won't script moz-extension pages directly, so extension pages are
loaded in the parent process (extensions.webextensions.remote=false) and
driven from the chrome context. Screenshots go to tests/out/.
"""
import argparse, http.server, json, os, sys, threading, time, glob
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.common.actions.action_builder import ActionBuilder

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
UUID = "6b1f7d8e-0000-4000-8000-00000000abcd"
EXT = "moz-extension://" + UUID
PORT = 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.join(HERE, "fixtures"), **kw)

    def end_headers(self):
        # Strict style-src: a <style> element added by a content script would be blocked.
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self' 'unsafe-inline'; img-src 'self'")
        super().end_headers()

    def log_message(self, *a):
        pass


EXT_CALL = """
const [path, args, uuid, done] = arguments;
const b = gBrowser.browsers.find(b => b.currentURI.spec.startsWith('moz-extension://' + uuid));
const w = b.contentWindow.wrappedJSObject;
let obj = w.browser, self = null;
for (const p of path.split('.')) { self = obj; obj = obj[p]; }
obj.apply(self, Cu.cloneInto(args, w)).then(
  Cu.exportFunction(v => done(v === undefined ? null : JSON.parse(w.JSON.stringify(v))), w),
  Cu.exportFunction(e => done('ERR ' + e), w));
"""

EXT_DOM = """
const [code, uuid] = arguments;
const b = gBrowser.browsers.find(b => b.currentURI.spec.startsWith('moz-extension://' + uuid));
const doc = b.contentDocument;
return (new Function('doc', 'b', code))(doc, b);
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--firefox", required=True)
    ap.add_argument("--geckodriver", required=True)
    args = ap.parse_args()

    xpi = sorted(glob.glob(os.path.join(ROOT, "web-ext-artifacts", "*.zip")))[-1]
    out = os.path.join(HERE, "out")
    os.makedirs(out, exist_ok=True)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    opts = Options()
    opts.binary_location = args.firefox
    opts.add_argument("-headless")
    opts.set_preference("extensions.webextensions.uuids", json.dumps({"page-patcher@staktrace.com": UUID}))
    opts.set_preference("extensions.webextensions.remote", False)
    driver = webdriver.Firefox(options=opts, service=Service(args.geckodriver, service_args=["--allow-system-access"]))
    driver.set_window_size(1280, 900)
    failures = []

    def check(name, cond, detail=""):
        print(("PASS " if cond else "FAIL ") + name + ("" if cond else " -- " + str(detail)))
        if not cond:
            failures.append(name)

    def ext_call(path, *a):
        driver.set_context("chrome")
        try:
            return driver.execute_async_script(EXT_CALL, path, list(a), UUID)
        finally:
            driver.set_context("content")

    def ext_dom(code):
        driver.set_context("chrome")
        try:
            return driver.execute_script(EXT_DOM, code, UUID)
        finally:
            driver.set_context("content")

    try:
        driver.install_addon(xpi, temporary=True)
        # The add-on opens its options page on first install (no API key yet).
        opened = False
        for _ in range(20):
            driver.set_context("chrome")
            opened = driver.execute_script("return gBrowser.browsers.some(b => b.currentURI.spec.startsWith('moz-extension://'))")
            driver.set_context("content")
            if opened:
                break
            time.sleep(0.5)
        check("options page opens on install", opened)
        time.sleep(1)

        saved = {
            "id": "psaved1",
            "description": "Lets you paste into the login fields and hides the notices.",
            "ops": [
                {"type": "unblockEvents", "selector": "input, textarea", "events": ["paste", "copy", "contextmenu", "drop", "keydown"]},
                {"type": "addCSS", "css": ".left { display: none !important; }"},
                {"type": "setStyle", "selector": ".right", "props": {"float": "none", "width": "auto"}},
            ],
            "enabled": True,
            "pathPattern": "",
            "instruction": "let me paste",
            "createdAt": 0,
        }
        r = ext_call("storage.local.set", {"patches:127.0.0.1": [saved], "settings": {"floatingButton": "on"}})
        check("seeded storage", r is None, r)

        driver.switch_to.new_window("tab")
        page_handle = driver.current_window_handle
        driver.get("http://127.0.0.1:%d/paste-blocked.html" % PORT)
        time.sleep(2)
        page_js = """
            const pw = document.getElementById('txtPassword');
            const ev = new Event('paste', {bubbles: true, cancelable: true});
            pw.dispatchEvent(ev);
            const kv = new KeyboardEvent('keydown', {key: 'v', ctrlKey: true, bubbles: true, cancelable: true});
            pw.dispatchEvent(kv);
            return {
              pastePrevented: ev.defaultPrevented,
              ctrlVPrevented: kv.defaultPrevented,
              onpasteAttr: pw.getAttribute('onpaste'),
              leftDisplay: getComputedStyle(document.querySelector('.left')).display,
              rightFloat: getComputedStyle(document.querySelector('.right')).cssFloat,
              btnFont: getComputedStyle(document.querySelector('.btn-login')).fontSize,
              fab: !!document.getElementById('page-patcher-root'),
            };"""
        before = driver.execute_script(page_js)
        print("page:", before)
        check("paste is no longer prevented", before["pastePrevented"] is False, before)
        check("Ctrl+V is no longer prevented", before["ctrlVPrevented"] is False, before)
        check("onpaste attribute stripped", before["onpasteAttr"] is None, before)
        check("addCSS works under a strict style-src CSP", before["leftDisplay"] == "none", before)
        check("setStyle applied", before["rightFloat"] == "none", before)
        check("floating button injected", before["fab"], before)
        driver.save_screenshot(os.path.join(out, "page-patched.png"))

        # Click the floating button (inside a closed shadow root) by position.
        # Phone-sized window: the panel should open as a bottom sheet.
        driver.set_window_size(412, 900)
        time.sleep(1)
        w, h = driver.execute_script("return [innerWidth, innerHeight]")
        actions = ActionBuilder(driver)
        actions.pointer_action.move_to_location(w - 37, h - 107).click()
        actions.perform()
        time.sleep(2.5)
        driver.save_screenshot(os.path.join(out, "panel-open.png"))
        driver.set_context("chrome")
        frames = driver.execute_script(
            "return gBrowser.selectedBrowser.browsingContext.getAllBrowsingContextsInSubtree().map(bc => bc.currentURI ? bc.currentURI.spec : '')"
        )
        panel_tabs = driver.execute_script("return gBrowser.browsers.filter(b => b.currentURI.spec.includes('popup.html')).length")
        driver.set_context("content")
        check("floating button opens the in-page panel iframe", any("popup/popup.html?embedded=1" in f for f in frames), frames)
        time.sleep(2)
        driver.set_context("chrome")
        panel_tabs = driver.execute_script("return gBrowser.browsers.filter(b => b.currentURI.spec.includes('popup.html')).length")
        driver.set_context("content")
        check("panel loaded (no fallback tab opened)", panel_tabs == 0, panel_tabs)
        driver.set_window_size(1280, 900)
        driver.refresh()  # close the panel
        time.sleep(2)

        tabs = ext_call("tabs.query", {})
        tab_id = next(t["id"] for t in tabs if t.get("url", "").startswith("http://127.0.0.1"))
        draft = {
            "id": "pdraft1",
            "description": "Makes the login button bigger.",
            "ops": [{"type": "setStyle", "selector": ".btn-login", "props": {"font-size": "24px"}}],
            "instruction": "bigger button",
            "createdAt": 1,
        }
        r = ext_call("tabs.sendMessage", tab_id, {"type": "setDraft", "patch": draft})
        check("setDraft applies to the page", isinstance(r, dict) and r["results"][0]["matches"] == 1, r)

        ext_dom("doc.defaultView.location.href = %s;" % json.dumps(EXT + "/popup/popup.html?tabId=%d" % tab_id))
        time.sleep(2)
        ui = ext_dom(
            """return {
              host: doc.getElementById('host').textContent,
              unavailable: !doc.getElementById('unavailable').hidden,
              draftShown: !doc.getElementById('draft').hidden,
              draftDesc: doc.getElementById('draft-desc').textContent,
              saved: Array.from(doc.querySelectorAll('#saved .desc'), e => e.textContent),
              nokey: !doc.getElementById('nokey').hidden,
              fluid: doc.body.classList.contains('fluid'),
            };"""
        )
        print("popup:", ui)
        check("popup sees the page", ui["host"] == "127.0.0.1" and not ui["unavailable"], ui)
        check("popup lists the saved patch", saved["description"] in ui["saved"], ui)
        check("popup shows the draft", ui["draftShown"] and ui["draftDesc"] == draft["description"], ui)
        check("popup shows the missing-key notice", ui["nokey"], ui)
        check("popup uses the fluid layout in a tab", ui["fluid"], ui)

        ext_dom("doc.getElementById('draft-save').click();")
        time.sleep(1)
        stored = ext_call("storage.local.get", "patches:127.0.0.1")["patches:127.0.0.1"]
        check("draft saved as an enabled patch", any(p["id"] == "pdraft1" and p["enabled"] for p in stored), stored)

        ext_dom("doc.getElementById('prompt').value = 'let me paste'; doc.getElementById('generate').click();")
        time.sleep(2)
        err = ext_dom("return doc.getElementById('error').textContent;")
        check("generating without a key explains why", "API key" in err, err)

        ext_dom("doc.querySelector('#saved .enabled').click();")  # first saved patch off
        time.sleep(1.5)
        ext_dom("doc.defaultView.resizeTo && 0;")
        driver.switch_to.window(page_handle)
        after = driver.execute_script(page_js)
        print("after toggling off:", after)
        check("toggled-off patch: CSS removed", after["leftDisplay"] != "none", after)
        check("toggled-off patch: onpaste restored", after["onpasteAttr"] == "return false;", after)
        check("toggled-off patch: paste blocked again", after["pastePrevented"] is True, after)
        check("saved draft still applied", after["btnFont"] == "24px", after)

        driver.refresh()
        time.sleep(2)
        reload_state = driver.execute_script(page_js)
        check("after reload only the enabled patch applies", reload_state["btnFont"] == "24px" and reload_state["leftDisplay"] != "none", reload_state)
    finally:
        driver.quit()
        srv.shutdown()
    print("FAILURES:", failures if failures else "none")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
