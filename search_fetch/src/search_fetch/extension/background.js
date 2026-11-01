// search_fetch bridge — service worker of the Chrome extension.
// The local `sf bridge-host` process (started by Chrome through native messaging) sends
// commands {id, op, ...}; this worker opens pages in a dedicated window of THIS Chrome,
// runs the fixed scripts in ops/ on them and answers {id, ok, result} or {id, ok:false, error}.
// No code strings are ever evaluated: every page script is a static file shipped here.

// Native messaging host name (must match the host manifest written by `sf bridge install`).
const HOST = "com.writeragent.search_fetch";
// Protocol version reported to the host.
const VERSION = "1.0.0";
// Page scripts that may be run (file names in ops/ without .js).
const SCRIPTS = new Set(["html", "meta", "probe", "observe", "results", "extent", "url",
  "scroll_bottom", "click_target", "type_target", "next_link", "more_button", "activity_install", "activity_last"]);
// Longest wait for a page load (ms) when the caller gives none.
const LOAD_TIMEOUT = 30000;
// Tabs older than this (ms) are closed by the reaper (a crashed sf never leaks tabs for long).
const TAB_MAX_AGE = 15 * 60 * 1000;

// The open native messaging port (null while disconnected).
let port = null;

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
    if (port) port.postMessage({ id: msg.id, ok: false, error: String(e && e.message || e) });
  }
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
async function dedicatedWindow(reg) {
  // Reuse it while it exists.
  if (reg.windowId !== null) {
    try {
      await chrome.windows.get(reg.windowId);
      return reg.windowId;
    } catch (_) {
      // It was closed by the user.
      reg.windowId = null;
    }
  }
  // A normal window that does not take focus from the user's work.
  const w = await chrome.windows.create({ url: "about:blank", focused: false, type: "normal", width: 1280, height: 900 });
  // Remember it.
  reg.windowId = w.id;
  // Its id.
  return w.id;
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

// Facts about a tab for the caller.
async function tabInfo(tabId, timedOut) {
  // Current state.
  const t = await chrome.tabs.get(tabId);
  // Id, final URL, title and whether the load wait ran out.
  return { tab: tabId, url: t.url || "", title: t.title || "", timedOut: !!timedOut };
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

// Operations by name.
const OPS = {
  // Version, window and open tabs.
  async status() {
    const reg = await registry();
    return { version: VERSION, windowId: reg.windowId, tabs: Object.keys(reg.tabs).length };
  },
  // Open url in a new tab of the dedicated window and wait for it to load.
  async open(msg) {
    const reg = await registry();
    await reap(reg);
    const windowId = await dedicatedWindow(reg);
    const tab = await chrome.tabs.create({ windowId, url: msg.url, active: true });
    reg.tabs[tab.id] = { run: msg.run || "", created: Date.now() };
    await saveRegistry(reg);
    const w = await waitLoaded(tab.id, msg.load_ms);
    return tabInfo(tab.id, w.timedOut);
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
    if (!SCRIPTS.has(msg.script)) throw new Error(`unknown script ${msg.script}`);
    const world = msg.world === "MAIN" ? "MAIN" : "ISOLATED";
    const target = { tabId: msg.tab };
    await chrome.scripting.executeScript({ target, world, func: (a) => { window.__sfArgs = a; }, args: [msg.args || {}] });
    const [res] = await chrome.scripting.executeScript({ target, world, files: [`ops/${msg.script}.js`] });
    return res ? res.result : null;
  },
  // Close one tab.
  async close(msg) {
    const reg = await registry();
    await chrome.tabs.remove(msg.tab).catch(() => {});
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
    await chrome.windows.update(t.windowId, { focused: true });
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
