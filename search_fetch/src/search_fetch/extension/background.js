// JiaWriter browser helper — service worker of the Chrome extension.
// The local host (the jiawriter program, or `sf bridge-host`, started by Chrome through native
// messaging) sends commands {id, op, ...}; this worker opens pages in a dedicated window of THIS
// Chrome, runs the fixed scripts in ops/ on them, and answers {id, ok, result} or {id, ok:false, error}.
// No code strings are ever evaluated: every page script is a static file shipped here.
// Clicks, typing and scrolling go through chrome.debugger's Input domain, so pages receive the same
// trusted events a person's mouse and keyboard produce; nothing else of the protocol is used.

// Native messaging host name (must match the host manifest the jiawriter program writes).
const HOST = "com.jiawriter.browser";
// Version reported to the host: the manifest's, so the two never differ.
const VERSION = chrome.runtime.getManifest().version;
// Page scripts that may be run (file names in ops/ without .js).
const SCRIPTS = new Set(["features", "html", "meta", "probe", "observe", "results", "extent", "url", "scroll_bottom",
  "click_target", "type_target", "next_link", "more_button", "activity_install", "activity_last",
  "locate", "serp", "article"]);
// Scripts that need a vendored library injected first.
const PRELOAD = { article: ["vendor/Readability.js"] };
// Longest wait for a page load (ms) when the caller gives none.
const LOAD_TIMEOUT = 30000;
// Tabs older than this (ms) are closed by the reaper (a crashed client never leaks tabs for long).
const TAB_MAX_AGE = 15 * 60 * 1000;
// Debugger protocol version for chrome.debugger.attach.
const CDP_VERSION = "1.3";
// Largest document the download op returns (bytes).
const DOWNLOAD_MAX = 40 * 1024 * 1024;

// The open native messaging port (null while disconnected).
let port = null;
// Last mouse position per tab in viewport pixels, so the pointer moves on from where it stopped.
const mouse = new Map();

// Connect to the host; an open port also keeps this service worker alive (Chrome 105+).
function connect() {
  // Already connected.
  if (port) return;
  // Start (or attach to) the host process.
  port = chrome.runtime.connectNative(HOST);
  // Commands from the host.
  port.onMessage.addListener(onCommand);
  // The host exited or is not installed.
  port.onDisconnect.addListener(() => {
    // Read lastError so Chrome does not log it as unchecked.
    void chrome.runtime.lastError;
    // Forget the port.
    port = null;
    // Try again shortly; the alarm below retries later too.
    setTimeout(connect, 5000);
  });
  // Tell the host who we are.
  port.postMessage({ hello: VERSION });
}

// Answer one command.
async function onCommand(msg) {
  // Run the operation and reply with its result or error.
  try {
    // Unknown operations are refused.
    const fn = OPS[msg.op];
    if (!fn) throw new Error(`unknown op ${msg.op}`);
    // The result.
    const result = await fn(msg);
    // Success.
    if (port) port.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    // Failure with the message only.
    if (port) port.postMessage({ id: msg.id, ok: false, error: String((e && e.message) || e) });
  }
}

// A pause of ms milliseconds.
function sleep(ms) {
  // Timer promise.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A random number between lo and hi.
function rand(lo, hi) {
  // Uniform.
  return lo + Math.random() * (hi - lo);
}

// Tab registry in session storage (survives a service-worker restart, not a browser restart).
async function registry() {
  // {tabs: {tabId: {run, created}}, windowId}.
  const s = await chrome.storage.session.get(["tabs", "windowId"]);
  // Defaults.
  return { tabs: s.tabs || {}, windowId: s.windowId || null };
}

// Save the registry.
async function saveRegistry(reg) {
  // Both keys at once.
  await chrome.storage.session.set({ tabs: reg.tabs, windowId: reg.windowId });
}

// The dedicated, unfocused window all pages open in (created on first use).
async function dedicatedWindow(reg, url = "about:blank") {
  // Reuse it while it exists.
  if (reg.windowId !== null) {
    try {
      await chrome.windows.get(reg.windowId);
      return { id: reg.windowId, created: false };
    } catch (_) {
      // It was closed by the user.
      reg.windowId = null;
    }
  }
  // The window the user is working in, to hand focus back to it.
  const prev = await chrome.windows.getLastFocused().catch(() => null);
  // A normal window (not minimized: a minimized page stops drawing and reports itself hidden) that does not
  // take focus from the user's work.
  const w = await chrome.windows.create({ url, focused: false, type: "normal", state: "normal", width: 1280, height: 900 });
  // Some window managers raise a new window anyway: give focus straight back, so it stays behind.
  if (prev && prev.id !== undefined && prev.id !== w.id && prev.focused) await chrome.windows.update(prev.id, { focused: true }).catch(() => {});
  // Remember it.
  reg.windowId = w.id;
  // Its id; the new window already shows url.
  return { id: w.id, created: true };
}

// Wait until a tab finishes loading (resolves {timedOut} instead of failing on timeout).
function waitLoaded(tabId, timeout) {
  // One promise per wait.
  return new Promise((resolve) => {
    // Stop listening and resolve once.
    let done = false;
    const finish = (timedOut) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve({ timedOut });
    };
    // Load completion events.
    const onUpdated = (id, info) => { if (id === tabId && info.status === "complete") finish(false); };
    chrome.tabs.onUpdated.addListener(onUpdated);
    // The tab may already be complete.
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") finish(false); }).catch(() => finish(false));
    // Upper bound.
    const timer = setTimeout(() => finish(true), timeout || LOAD_TIMEOUT);
  });
}

// Watch a tab after an input action: did it start a navigation, and did it open a new tab?
// Returns {wait()} that resolves {navigated, newTab, timedOut} once the resulting load ends.
function watchNavigation(tabId, startMs, loadMs) {
  // What was seen.
  const seen = { navigated: false, newTab: null };
  // A load starting in this tab.
  const onUpdated = (id, info) => { if (id === tabId && info.status === "loading") seen.navigated = true; };
  // A tab opened by this one (a link with target=_blank).
  const onCreated = (t) => { if (t.openerTabId === tabId && seen.newTab === null) seen.newTab = t.id; };
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onCreated.addListener(onCreated);
  // The waiting half.
  async function wait() {
    // Give the page startMs to begin navigating or opening a tab.
    const until = Date.now() + startMs;
    while (Date.now() < until && !seen.navigated && seen.newTab === null) await sleep(100);
    // Listeners are no longer needed.
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onCreated.removeListener(onCreated);
    // Nothing happened: an in-page action.
    if (!seen.navigated && seen.newTab === null) return { navigated: false, newTab: null, timedOut: false };
    // Wait for the tab that is loading.
    const w = await waitLoaded(seen.newTab !== null ? seen.newTab : tabId, loadMs);
    // The outcome.
    return { navigated: seen.navigated, newTab: seen.newTab, timedOut: w.timedOut };
  }
  // The watcher.
  return { wait };
}

// Facts about a tab for the caller.
async function tabInfo(tabId, timedOut) {
  // Current state.
  const t = await chrome.tabs.get(tabId);
  // Id, final URL, title and whether the load wait ran out.
  return { tab: tabId, url: t.url || "", title: t.title || "", timedOut: !!timedOut, front: !!t.active && (await chrome.windows.get(t.windowId)).focused };
}

// Close tabs that outlived TAB_MAX_AGE.
async function reap(reg) {
  // Now.
  const now = Date.now();
  // Each registered tab.
  for (const [id, rec] of Object.entries(reg.tabs)) {
    if (now - rec.created > TAB_MAX_AGE) {
      // Already gone is fine.
      await chrome.tabs.remove(Number(id)).catch(() => {});
      delete reg.tabs[id];
    }
  }
}

// Run one fixed page script (plus its preloaded libraries) with args and return its value.
async function runScript(tabId, script, args, world) {
  // Only known scripts.
  if (!SCRIPTS.has(script)) throw new Error(`unknown script ${script}`);
  // Isolated world unless the script must read page globals.
  const w = world === "MAIN" ? "MAIN" : "ISOLATED";
  const target = { tabId };
  // Hand the arguments over first; in the page's own world only when there are any (a global there is
  // visible to the page's scripts).
  if (w === "ISOLATED" || (args && Object.keys(args).length > 0))
    await chrome.scripting.executeScript({ target, world: w, func: (a) => { window.__sfArgs = a; }, args: [args || {}] });
  // Libraries the script needs.
  for (const file of PRELOAD[script] || []) await chrome.scripting.executeScript({ target, world: w, files: [file] });
  // The script; its last expression is the result.
  const [res] = await chrome.scripting.executeScript({ target, world: w, files: [`ops/${script}.js`] });
  // The value.
  return res ? res.result : null;
}

// Run fn(send) with the debugger attached to the tab, then detach (the bar Chrome shows goes away).
async function withInput(tabId, fn) {
  // Debuggee.
  const target = { tabId };
  // Attach; fails when DevTools or another debugger holds the tab.
  await chrome.debugger.attach(target, CDP_VERSION);
  try {
    // Send one protocol command.
    const send = (method, params) => chrome.debugger.sendCommand(target, method, params || {});
    // The page sees itself focused, as it would under a person's hands.
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    // The caller's input.
    return await fn(send);
  } finally {
    // Always let go.
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// Minimum-jerk easing: slow start, faster middle, slow arrival, as a hand moves.
function ease(t) {
  return t * t * t * (10 - 15 * t + 6 * t * t);
}

// One curved stroke from `from` to (x, y): a cubic Bézier bent to a random side, eased, with a small
// tremor that fades near the end. Positions are whole pixels, as a real mouse reports them.
async function stroke(send, from, x, y) {
  // Distance and direction.
  const dx = x - from.x, dy = y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return;
  // The normal of the line, and how far the path bends off it (more for longer moves, random side).
  const nx = -dy / dist, ny = dx / dist;
  const bend = dist * rand(0.08, 0.3) * (Math.random() < 0.5 ? -1 : 1);
  // Two control points along the line, both pushed off it (the second less, so the end straightens).
  const c1 = { x: from.x + dx * rand(0.2, 0.4) + nx * bend, y: from.y + dy * rand(0.2, 0.4) + ny * bend };
  const c2 = { x: from.x + dx * rand(0.6, 0.85) + nx * bend * rand(0.2, 0.6), y: from.y + dy * rand(0.6, 0.85) + ny * bend * rand(0.2, 0.6) };
  // Steps: more for longer moves, never the same count twice in a row.
  const steps = Math.max(10, Math.min(70, Math.round(dist / rand(12, 22))));
  let last = { x: Math.round(from.x), y: Math.round(from.y) };
  for (let i = 1; i <= steps; i++) {
    const t = ease(i / steps), u = 1 - t;
    // Cubic Bézier point.
    let px = u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * x;
    let py = u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * y;
    // Tremor of up to a pixel, gone at the end.
    const tremor = (1 - i / steps) * 1.2;
    px += rand(-tremor, tremor);
    py += rand(-tremor, tremor);
    const at = { x: Math.round(px), y: Math.round(py) };
    // Same pixel: no event.
    if (at.x !== last.x || at.y !== last.y) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
      last = at;
    }
    // Event spacing like a 60–125 Hz mouse, with a rare short hitch.
    await sleep(Math.random() < 0.04 ? rand(40, 90) : rand(7, 17));
  }
  // Land exactly on the target pixel.
  if (last.x !== Math.round(x) || last.y !== Math.round(y)) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x), y: Math.round(y) });
}

// Move the pointer from its last position to (x, y) like a hand: a curved, eased stroke; on longer
// moves now and then a small overshoot and a short correction back.
async function moveMouse(send, tabId, x, y) {
  // Start: last position, else a random resting point of the hand.
  const from = mouse.get(tabId) || { x: Math.round(rand(80, 500)), y: Math.round(rand(80, 400)) };
  const dist = Math.hypot(x - from.x, y - from.y);
  if (dist > 200 && Math.random() < 0.25) {
    // Past the target by 3–8 % of the way, then back.
    const k = 1 + rand(0.03, 0.08);
    const over = { x: from.x + (x - from.x) * k, y: from.y + (y - from.y) * k };
    await stroke(send, from, over.x, over.y);
    await sleep(rand(60, 180));
    await stroke(send, over, x, y);
  } else {
    await stroke(send, from, x, y);
  }
  // Remember where the pointer is.
  mouse.set(tabId, { x: Math.round(x), y: Math.round(y) });
}

// A small idle drift of the pointer (a resting hand), kept inside the viewport.
async function drift(send, tabId) {
  // Where it is now.
  const at = mouse.get(tabId) || { x: Math.round(rand(400, 800)), y: Math.round(rand(300, 500)) };
  // 15–120 px in a random direction.
  const angle = rand(0, Math.PI * 2), len = rand(15, 120);
  const x = Math.max(20, Math.min(1180, at.x + Math.cos(angle) * len));
  const y = Math.max(80, Math.min(760, at.y + Math.sin(angle) * len));
  await moveMouse(send, tabId, x, y);
}

// Scroll by dy pixels with a few wheel notches at the pointer position.
async function wheel(send, tabId, dy) {
  // Pointer position (the wheel acts on what is under it).
  const at = mouse.get(tabId) || { x: rand(400, 800), y: rand(300, 500) };
  // Notches of 100 px, as Chrome reports a mouse wheel.
  const notches = Math.max(1, Math.round(Math.abs(dy) / 100));
  for (let i = 0; i < notches; i++) {
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: Math.sign(dy) * 100 });
    // Notch spacing of a turned wheel.
    await sleep(rand(35, 110));
  }
}

// Accessibility tree: what Chrome tells screen readers about the page — each element's role (text box,
// button, link), the name it shows, a link's address — with its box on screen. Targets are found the way a
// person reads the screen, without CSS selectors or page scripts.
function axRole(n) {
  return (n.role && n.role.value) || "";
}
function axName(n) {
  return String((n.name && n.name.value) || "").trim();
}
function axProp(n, name) {
  const p = (n.properties || []).find((q) => q.name === name);
  return p && p.value ? p.value.value : undefined;
}

// True when link address u leads to the next results page of current address c: same site, same query,
// and a larger page counter (first= Bing, start= Google, pn= Baidu, page= Sogou and others).
function nextPageUrl(u, c) {
  let a, b;
  try { a = new URL(u); b = new URL(c); } catch (_) { return false; }
  if (a.host !== b.host) return false;
  // The same query words.
  for (const k of ["q", "wd", "word", "query"]) if (a.searchParams.has(k) && b.searchParams.has(k) && a.searchParams.get(k) !== b.searchParams.get(k)) return false;
  // A larger page counter.
  for (const k of ["first", "start", "pn", "page"]) {
    if (!a.searchParams.has(k)) continue;
    const now = Number(b.searchParams.get(k) || (k === "page" || k === "first" ? 1 : 0));
    return Number(a.searchParams.get(k)) > now;
  }
  return false;
}

// The on-screen box of an accessibility node (viewport pixels), or null.
async function axBox(send, n) {
  try {
    const { model } = await send("DOM.getBoxModel", { backendNodeId: n.backendDOMNodeId });
    const q = model.border, xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  } catch (_) {
    return null;
  }
}

// Find ax = {roles, name (pattern), pick: "largest", nextPage} in the accessibility tree; returns the
// box like locate.js ({found, x, y, w, h, vw, vh}).
async function axLocate(send, tabId, ax) {
  const { nodes } = await send("Accessibility.getFullAXTree", {});
  const tab = await chrome.tabs.get(tabId);
  const { cssLayoutViewport: vp } = await send("Page.getLayoutMetrics", {});
  const roles = new Set(ax.roles || []);
  const re = ax.name ? new RegExp(ax.name, "i") : null;
  // Candidates: by name first, then by address (next page), in page order.
  const byName = [], byPage = [];
  for (const n of nodes) {
    if (n.ignored || n.backendDOMNodeId === undefined || !roles.has(axRole(n)) || axProp(n, "disabled")) continue;
    if (!re || re.test(axName(n))) byName.push(n);
    else if (ax.nextPage && nextPageUrl(String(axProp(n, "url") || ""), tab.url || "")) byPage.push(n);
  }
  let best = null;
  for (const n of [...byName, ...byPage]) {
    const found = await axBox(send, n);
    if (!found || found.w < 2 || found.h < 2) continue;
    // The node itself, so keyboard focus goes to exactly this control.
    const box = { ...found, node: n.backendDOMNodeId };
    if (ax.pick !== "largest") { best = box; break; }
    if (!best || box.w * box.h > best.w * best.h) best = box;
  }
  return best ? { found: true, ...best, vw: vp.clientWidth, vh: vp.clientHeight } : { found: false };
}

// The results list as a person reads it: every heading that carries a link is one result (Google puts the
// heading inside the link, Bing, Baidu and Sogou the link inside the heading). Title = the heading's name,
// address = the link's, snippet = the other text shown in the same block. A block that shows an ad label on
// its own is skipped. Returns [{u, t, s}] in page order.
const AD_LABEL = /^(广告|推广|赞助|品牌广告|Ad|Ads|Sponsored)$/i;
// In the extension's isolated world, from a redirect link up to the nearest block that states the real address:
// an mu attribute (Baidu) or a data-url inside it (Sogou). Placeholder and search-page addresses do not count.
const REAL_URL_FN = `function () {
  const ok = (u) => /^https?:\\/\\//.test(u || "") && !/^https?:\\/\\/(nourl\\.|[^/]*recommend_list\\.|([^/]*\\.)?(sogou\\.com|so\\.html5\\.qq\\.com)\\/)/.test(u);
  for (let e = this, i = 0; e && e !== document.body && i < 12; e = e.parentElement, i++) {
    const mu = e.getAttribute && e.getAttribute("mu");
    // A Baidu module of its own (note_lead and others carry a placeholder mu): not a result.
    if (mu) return ok(mu) ? mu : "skip";
    const d = e.querySelectorAll ? [...e.querySelectorAll("[data-url]")].map((x) => x.getAttribute("data-url")).find(ok) : "";
    if (d) return d;
  }
  return "";
}`;

async function axResults(send, tabId) {
  const { nodes } = await send("Accessibility.getFullAXTree", {});
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const up = (n) => (n && n.parentId ? byId.get(n.parentId) : null);
  // Visible text under a node, in order (StaticText names).
  const texts = (n, out = [], depth = 0) => {
    if (!n || depth > 12) return out;
    if (!n.ignored && axRole(n) === "StaticText" && axName(n)) out.push(axName(n));
    for (const c of n.childIds || []) texts(byId.get(c), out, depth + 1);
    return out;
  };
  const firstLink = (n, depth = 0) => {
    if (!n || depth > 6) return null;
    if (!n.ignored && axRole(n) === "link" && axProp(n, "url")) return n;
    for (const c of n.childIds || []) { const l = firstLink(byId.get(c), depth + 1); if (l) return l; }
    return null;
  };
  const out = [], seen = new Set();
  for (const h of nodes) {
    if (h.ignored || axRole(h) !== "heading") continue;
    // The link around the heading, else the first link inside it.
    let link = null, top = h;
    for (let p = up(h), i = 0; p && i < 3; p = up(p), i++) if (axRole(p) === "link" && axProp(p, "url")) { link = p; top = p; break; }
    if (!link) link = firstLink(h);
    if (!link) continue;
    const u = String(axProp(link, "url") || "");
    const t = axName(h) || axName(link);
    if (!/^https?:\/\//.test(u) || !t || seen.has(u)) continue;
    // The block: two levels above the heading (or the link around it).
    let block = top;
    for (let i = 0; i < 2 && up(block); i++) block = up(block);
    const words = texts(block);
    if (words.some((w) => AD_LABEL.test(w.trim()))) continue;
    const titleWords = new Set(texts(top));
    const s = words.filter((w) => !titleWords.has(w)).join(" ").replace(/\s+/g, " ").trim().slice(0, 400);
    seen.add(u);
    out.push({ u, t: t.slice(0, 200), s, node: link.backendDOMNodeId });
  }
  // An engine's own /link redirects: the real address read from the result block (page code only here).
  const page = await chrome.tabs.get(tabId).then((t) => new URL(t.url).host).catch(() => "");
  const wrapped = out.filter((r) => {
    try {
      const u = new URL(r.u);
      return u.pathname === "/link" && (u.host === page || /(^|\.)(baidu|sogou)\.com$/.test(u.hostname));
    } catch (_) {
      return false;
    }
  });
  if (wrapped.length > 0) {
    const { frameTree } = await send("Page.getFrameTree");
    const { executionContextId } = await send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "jw-read" });
    for (const r of wrapped) {
      try {
        const { object } = await send("DOM.resolveNode", { backendNodeId: r.node, executionContextId });
        const v = await send("Runtime.callFunctionOn", { objectId: object.objectId, returnByValue: true, functionDeclaration: REAL_URL_FN });
        if (v && v.result && v.result.value) r.u = v.result.value;
      } catch (_) {
        // Left as the redirect.
      }
    }
  }
  return out.filter((r) => r.u !== "skip").map(({ node: _node, ...r }) => r);
}

// Where the target is now: the accessibility tree first (target.ax), CSS selectors only as a fallback.
async function where(send, tabId, target) {
  if (target.ax) {
    const box = await axLocate(send, tabId, target.ax).catch(() => ({ found: false }));
    if (box.found) return { ...box, via: "ax" };
  }
  if (!target.selectors && !target.wfId && target.ref === undefined) return { found: false };
  const box = await runScript(tabId, "locate", target);
  return box && box.found ? { ...box, via: target.ax ? (target.selectors ? "css" : "script") : "ref" } : { found: false };
}

// Bring the target into view with the wheel and return its box, or null when it is not on the page.
async function reach(send, tabId, target) {
  // Where is it? (The whole accessibility tree is read once.)
  let box = await where(send, tabId, target);
  // Rounds of scroll and look again, enough for a long page that loaded more results.
  for (let round = 0; round < 30; round++) {
    if (!box || !box.found) return null;
    // Inside the viewport with a margin: done.
    if (box.y >= 70 && box.y + box.h <= box.vh - 50) return box;
    // Scroll towards its centre.
    await wheel(send, tabId, Math.max(-700, Math.min(700, box.y + box.h / 2 - box.vh / 2)));
    // Let the page settle.
    await sleep(rand(250, 600));
    // The same node's new box (cheap); a target without a node is looked up again.
    const moved = box.node ? await axBox(send, { backendDOMNodeId: box.node }) : null;
    box = moved ? { ...box, ...moved } : await where(send, tabId, target);
  }
  // Still not in view: report its last box anyway (a fixed header may cover the margin).
  return box && box.found ? box : null;
}

// Press and release the left button at the current pointer position.
async function clickHere(send, tabId) {
  // Where the pointer is.
  const at = mouse.get(tabId);
  // Down, a short hold, up.
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(rand(50, 130));
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1 });
}

// Move to the target and click it; null when the target is not on the page.
// True when the tab's window is the one in front: a mouse press cannot take focus from the user then.
async function inFront(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return !!(await chrome.windows.get(t.windowId)).focused;
  } catch (_) {
    return false;
  }
}

// Give keyboard focus to the element under (x, y), or to the link, button or field around it, without a mouse
// press (on GNOME a press raises the window, 2026-11-03; focus, keys, wheel and moves do not). Runs in an
// isolated world of the extension, so the page's own scripts are not touched. Returns the focused tag or "".
async function focusAt(send, x, y, node) {
  // The control found on screen, else the element under the pointer.
  const backendNodeId = node || (await send("DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y) })).backendNodeId;
  const { frameTree } = await send("Page.getFrameTree");
  const { executionContextId } = await send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "jw-input" });
  const { object } = await send("DOM.resolveNode", { backendNodeId, executionContextId });
  const r = await send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    returnByValue: true,
    functionDeclaration: "function () { const el = this.nodeType === 1 ? this : this.parentElement; const sel = 'a[href],button,input,textarea,select,[tabindex],[contenteditable=true],[role=button],[role=link],[role=textbox],[role=combobox]'; const t = (el && (el.closest(sel) || el.querySelector(sel))) || el; if (!t) return null; t.focus({ preventScroll: true }); if (document.activeElement !== t) return null; return { tag: t.tagName.toLowerCase(), href: t.tagName === 'A' ? t.href : '', blank: t.tagName === 'A' && (t.target === '_blank' || t.target === '_new') }; }",
  });
  return (r && r.result && r.result.value) || null;
}

// Move to the target and activate it; null when the target is not on the page. press: a link or button is
// opened (false: a field only receives focus). With the window in front this is a mouse click; behind the
// user's work it is the hover plus keyboard focus and Enter, so focus never leaves the user's window.
async function clickTarget(send, tabId, target, press = true, track = {}) {
  // In view first.
  track.stage = "reach";
  const box = await reach(send, tabId, target);
  if (!box) return null;
  // A point inside the box, away from the edges.
  const x = box.x + box.w * rand(0.3, 0.7);
  const y = box.y + box.h * rand(0.35, 0.65);
  // Pointer there and a short hover.
  await moveMouse(send, tabId, x, y);
  await sleep(rand(120, 350));
  // In front: the click.
  if (await inFront(tabId)) {
    await clickHere(send, tabId);
    return { ...box, how: "click" };
  }
  // Behind: keyboard focus, then Enter on a link or button; nothing that could raise the window.
  track.stage = "focus";
  const f = await focusAt(send, x, y, box.node).catch(() => null);
  if (!f) return { ...box, how: "unfocusable" };
  if (press && !/^(input|textarea|select)$/.test(f.tag)) {
    await sleep(rand(80, 220));
    // A link that would open a new tab (which raises the window): opened in this tab instead.
    if (f.blank && /^https?:/.test(f.href)) {
      track.stage = "link";
      await chrome.tabs.update(tabId, { url: f.href });
      return { ...box, how: "link" };
    }
    track.stage = "enter";
    await pressKey(send, "Enter");
  }
  return { ...box, how: "keyboard" };
}

// Key fields for one printable ASCII character.
function keyFields(ch) {
  // Letters and digits have codes; other characters go by text alone.
  const upper = ch.toUpperCase();
  if (/^[a-z]$/i.test(ch)) return { key: ch, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, windowsVirtualKeyCode: ch.charCodeAt(0) };
  if (ch === " ") return { key: " ", code: "Space", windowsVirtualKeyCode: 32 };
  return { key: ch };
}

// Type text into the focused field one character at a time, at a person's unhurried pace.
async function typeText(send, text) {
  // Characters (a CJK character is one input-method commit).
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (/^[\x20-\x7e]$/.test(ch)) {
      // A printable ASCII key: down (with its text), a short hold, up.
      const f = keyFields(ch);
      await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, ...f });
      await sleep(rand(30, 90));
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...f });
    } else {
      // Any other character: committed on its own, as an input method does.
      await send("Input.insertText", { text: ch });
    }
    // The gap before the next key: 140–320 ms, a little longer after a space, and now and then a pause.
    let gap = rand(140, 320);
    if (ch === " ") gap *= rand(1.2, 1.6);
    if (Math.random() < 0.12) gap += rand(450, 1100);
    if (i < chars.length - 1) await sleep(gap);
  }
}

// Press one named key (Enter, Escape, Tab).
async function pressKey(send, name) {
  // Fields per key.
  const keys = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  };
  const f = keys[name];
  if (!f) throw new Error(`unknown key ${name}`);
  // Down and up.
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...f });
  await sleep(rand(40, 110));
  const { text: _text, ...up } = f;
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...up });
}

// Run an input operation, but answer with the stage it reached when it takes longer than the load wait plus
// 45 s (the host stops waiting a little later): a slow page shows where the time went.
async function withDeadline(msg, track, fn) {
  const limit = (msg.load_ms || LOAD_TIMEOUT) + 45000;
  return Promise.race([
    fn(),
    sleep(limit).then(() => ({ clicked: false, typed: false, navigated: false, newTab: null, timedOut: true, how: "timeout", stage: track.stage })),
  ]);
}

// Base64 of bytes (chunked so large files do not overflow the argument list).
function toBase64(bytes) {
  // Binary string in chunks.
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  // Encoded.
  return btoa(s);
}

// Operations by name.
const OPS = {
  // Version, window, open tabs and the input capability.
  async status() {
    const reg = await registry();
    return { version: VERSION, windowId: reg.windowId, tabs: Object.keys(reg.tabs).length, input: true };
  },
  // Open url in a new tab of the dedicated window and wait for it to load.
  async open(msg) {
    const reg = await registry();
    await reap(reg);
    const { id: windowId, created } = await dedicatedWindow(reg, msg.url);
    // A new window shows the page already; otherwise a background tab that then becomes the window's active
    // tab (creating an active tab raises the window on GNOME; switching tabs inside it does not).
    let tab;
    if (created) tab = (await chrome.tabs.query({ windowId }))[0];
    else {
      tab = await chrome.tabs.create({ windowId, url: msg.url, active: false });
      await chrome.tabs.update(tab.id, { active: true });
    }
    reg.tabs[tab.id] = { run: msg.run || "", created: Date.now() };
    await saveRegistry(reg);
    const w = await waitLoaded(tab.id, msg.load_ms);
    return { ...(await tabInfo(tab.id, w.timedOut)), front: await inFront(tab.id) };
  },
  // Load url in an existing tab (a page turn).
  async navigate(msg) {
    await chrome.tabs.update(msg.tab, { url: msg.url });
    const w = await waitLoaded(msg.tab, msg.load_ms);
    return tabInfo(msg.tab, w.timedOut);
  },
  // Go one step back in the tab's history.
  async back(msg) {
    await chrome.tabs.goBack(msg.tab);
    const w = await waitLoaded(msg.tab, msg.load_ms);
    return tabInfo(msg.tab, w.timedOut);
  },
  // Facts about a tab without waiting.
  async info(msg) {
    return tabInfo(msg.tab, false);
  },
  // Run one fixed page script; args are handed over through the isolated world first.
  async run(msg) {
    return runScript(msg.tab, msg.script, msg.args, msg.world);
  },
  // Click the target (see ops/locate.js) with the mouse; reports navigation and a new tab.
  // {tab, target, load_ms} → {clicked, navigated, newTab, timedOut}.
  async human_click(msg) {
    const track = { stage: "start" };
    return withDeadline(msg, track, async () => {
    // Watch for the results of the click.
    const watch = watchNavigation(msg.tab, 4000, msg.load_ms);
    // Move and click.
    const box = await withInput(msg.tab, (send) => clickTarget(send, msg.tab, msg.target || {}, true, track));
    track.stage = "wait";
    // Not on the page.
    if (!box) {
      await watch.wait();
      return { clicked: false, navigated: false, newTab: null, timedOut: false };
    }
    // A tab opened by the click is registered so it gets closed like the others.
    const nav = await watch.wait();
    if (nav.newTab !== null) {
      const reg = await registry();
      reg.tabs[nav.newTab] = { run: msg.run || "", created: Date.now() };
      await saveRegistry(reg);
    }
    // The outcome, with how the target was found (ax, css or ref).
    if (box.how === "unfocusable") return { clicked: false, via: box.via || "", how: box.how, front: await inFront(msg.tab), ...nav };
    return { clicked: true, via: box.via || "", how: box.how || "", front: await inFront(msg.tab), ...nav };
    });
  },
  // The results list read from the accessibility tree. {tab} → {results: [{u, t, s}]}.
  async ax_results(msg) {
    return { results: await withInput(msg.tab, (send) => axResults(send, msg.tab)) };
  },
  // Only look for a target, without touching the page. {tab, target} → {found, via}.
  async find(msg) {
    const box = await withInput(msg.tab, (send) => where(send, msg.tab, msg.target || {}));
    return { found: !!box.found, via: box.via || "" };
  },
  // Click the field, type text and optionally press Enter. {tab, target, text, enter, load_ms}.
  async human_type(msg) {
    const track = { stage: "start" };
    return withDeadline(msg, track, async () => {
    // A submit may navigate.
    const watch = watchNavigation(msg.tab, msg.enter ? 6000 : 0, msg.load_ms);
    // Click into the field, pause, type, pause, Enter.
    const box = await withInput(msg.tab, async (send) => {
      // Into the field: a click in front, keyboard focus behind (no Enter on the field itself).
      const b = await clickTarget(send, msg.tab, msg.target || {}, false, track);
      track.stage = "type";
      if (!b) return null;
      await sleep(rand(300, 700));
      await typeText(send, String(msg.text || ""));
      if (msg.enter) {
        await sleep(rand(350, 900));
        await pressKey(send, "Enter");
      }
      return b;
    });
    // The field was not found.
    const nav = await watch.wait();
    if (!box) return { typed: false, navigated: false, newTab: null, timedOut: false };
    // The outcome.
    if (box.how === "unfocusable") return { typed: false, via: box.via || "", how: box.how, front: await inFront(msg.tab), ...nav };
    return { typed: true, via: box.via || "", how: box.how || "", front: await inFront(msg.tab), ...nav };
    });
  },
  // Press one key in the page. {tab, key, load_ms}.
  async human_key(msg) {
    const watch = watchNavigation(msg.tab, msg.key === "Enter" ? 5000 : 0, msg.load_ms);
    await withInput(msg.tab, (send) => pressKey(send, msg.key));
    return { pressed: true, ...(await watch.wait()) };
  },
  // Scroll like a reader: {tab, steps, px} → wheel turns of about px each, with pauses.
  async human_scroll(msg) {
    await withInput(msg.tab, async (send) => {
      // Pointer somewhere over the content first.
      if (!mouse.get(msg.tab)) await moveMouse(send, msg.tab, rand(450, 850), rand(300, 600));
      // The turns.
      for (let i = 0; i < (msg.steps || 3); i++) {
        await wheel(send, msg.tab, msg.px || rand(300, 700));
        // Reading time; the hand rests or drifts a little.
        if (Math.random() < 0.6) await drift(send, msg.tab);
        await sleep(rand(600, 1600));
      }
    });
    return true;
  },
  // Download a document through this Chrome (its cookies and network). {url, max} → {base64, type, url}.
  async download(msg) {
    // Same request a link click would make.
    const res = await fetch(msg.url, { credentials: "include", redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Size limit before and after reading.
    const max = Math.min(msg.max || DOWNLOAD_MAX, DOWNLOAD_MAX);
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > max) throw new Error(`document larger than ${max} bytes`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > max) throw new Error(`document larger than ${max} bytes`);
    // Bytes, type and final address.
    return { base64: toBase64(bytes), type: res.headers.get("content-type") || "", url: res.url };
  },
  // Close one tab.
  async close(msg) {
    const reg = await registry();
    await chrome.tabs.remove(msg.tab).catch(() => {});
    mouse.delete(msg.tab);
    delete reg.tabs[msg.tab];
    await saveRegistry(reg);
    return true;
  },
  // Close every tab opened for one run (all of them when run is empty).
  async close_run(msg) {
    const reg = await registry();
    let n = 0;
    for (const [id, rec] of Object.entries(reg.tabs)) {
      if (!msg.run || rec.run === msg.run) {
        await chrome.tabs.remove(Number(id)).catch(() => {});
        mouse.delete(Number(id));
        delete reg.tabs[id];
        n++;
      }
    }
    await saveRegistry(reg);
    return n;
  },
  // Bring a tab to the front so a person can solve a challenge in it.
  async activate(msg) {
    const t = await chrome.tabs.update(msg.tab, { active: true });
    // Out of a minimized state, to the front; where the desktop refuses that, the task bar entry flashes.
    await chrome.windows.update(t.windowId, { state: "normal" }).catch(() => {});
    await chrome.windows.update(t.windowId, { focused: true, drawAttention: true });
    return true;
  },
};

// Keep the bridge reconnecting: browser start, extension install/update and a periodic alarm.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create("sf-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "sf-reconnect") connect(); });
// And right now, when the worker starts.
connect();
