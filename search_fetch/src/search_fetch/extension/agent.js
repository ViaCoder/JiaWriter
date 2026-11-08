// JiaWriter browser tool — what the agent's `browser` tool does in a page, loaded by background.js after OPS.
// Pages are read from the accessibility tree of every frame, cross-site frames included, and acted on by the
// references that read gave out. Every operation is limited to tabs of the dedicated window. The search and
// fetch flows do not use this file. The one place code from outside runs is page_eval, and the program in front
// of this extension asks the user first.

// Roles a person can act on.
const ACT_ROLES = new Set(["button", "link", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox",
  "radio", "switch", "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem"]);
// Roles that give a page its shape, shown with the text.
const TEXT_ROLES = new Set(["heading", "StaticText", "paragraph", "listitem", "cell", "alert", "status", "dialog"]);
// Most characters a read gives back unless asked for fewer.
const READ_LIMIT = 12000;
// Most characters of an eval result.
const EVAL_LIMIT = 20000;
// How long frames get to announce themselves (ms).
const FRAME_SETTLE = 250;
// Longest wait for lazy content after a scroll, and how often to look (ms).
const SETTLE_MS = 1500;
const SETTLE_STEP = 150;
// How long a click or Enter gets to start a navigation (ms); a slower one shows up in the next read.
const NAV_WAIT = 600;
// How long one operation may hold the tab (ms): after this the debugger lets go, whatever the page does.
const ACTION_MS = 30000;
// What each tab's last read handed out.
const pageRefs = new Map();
// Tabs with a dialog open. The debugger stays attached to them: only the session that saw it can answer it.
const heldDialogs = new Map();

// Throw unless the tab is one the dedicated window opened: the user's own tabs are never touched.
async function ownTab(tabId) {
  const reg = await registry();
  if (!reg.tabs[tabId]) throw new Error("not a JiaWriter tab");
}

// A frame's sender: the tab itself, or a child session of a cross-site frame.
function senderFor(tabId, sessionId) {
  const target = sessionId ? { tabId, sessionId } : { tabId };
  return (method, params) => chrome.debugger.sendCommand(target, method, params || {});
}

// Run fn(page) with the tab attached and every cross-site frame reachable. page = {tabId, send, sessions, dialog}.
async function withPage(tabId, fn) {
  // A page behind a dialog answers nothing, and a second attach would fail.
  if (heldDialogs.has(tabId)) throw new Error("dialog-open");
  // Child sessions by id: their target and the session that owns them.
  const sessions = new Map();
  // Told when a page dialog opens: until it is answered, the page answers nothing else.
  let dialogOpened = () => {};
  const opened = new Promise((resolve) => { dialogOpened = resolve; });
  // A page dialog, once one opens.
  const page = { tabId, sessions, dialog: null, send: null, opened };
  // Everything Chrome announces while attached.
  const heard = (source, method, params) => {
    if (source.tabId !== tabId) return;
    if (method === "Target.attachedToTarget" && params.targetInfo.type === "iframe") {
      sessions.set(params.sessionId, { targetId: params.targetInfo.targetId, parent: source.sessionId || "" });
      // Auto attach is not recursive: each child is asked again.
      senderFor(tabId, params.sessionId)("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    } else if (method === "Target.detachedFromTarget") sessions.delete(params.sessionId);
    else if (method === "Page.javascriptDialogOpening") {
      page.dialog = { type: params.type, message: params.message };
      dialogOpened();
    }
    else if (method === "Page.javascriptDialogClosed") page.dialog = null;
  };
  chrome.debugger.onEvent.addListener(heard);
  page.heard = heard;
  const target = { tabId };
  await chrome.debugger.attach(target, CDP_VERSION);
  try {
    const send = senderFor(tabId, "");
    page.send = send;
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await send("Page.enable");
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    // Existing frames report right after the call.
    await sleep(FRAME_SETTLE);
    // A stuck page must not keep the debugger attached.
    return await Promise.race([fn(page), sleep(ACTION_MS).then(() => { throw new Error("the page did not answer"); })]);
  } finally {
    // The session stays for page_dialog; otherwise let go.
    if (page.dialog) heldDialogs.set(tabId, page);
    else await letGo(page);
  }
}

// Stop listening and detach.
async function letGo(page) {
  chrome.debugger.onEvent.removeListener(page.heard);
  heldDialogs.delete(page.tabId);
  await chrome.debugger.detach({ tabId: page.tabId }).catch(() => {});
}

// Frame ids of one session's own frames: same-site children live in the same session.
function localFrames(tree) {
  return [tree.frame.id, ...(tree.childFrames || []).flatMap(localFrames)];
}

// Everything readable: {frames: [{target, frameId, send}]} of all sessions; a session that is gone is skipped.
async function allFrames(page) {
  const out = [];
  for (const sessionId of ["", ...page.sessions.keys()]) {
    const send = senderFor(page.tabId, sessionId);
    const target = sessionId ? page.sessions.get(sessionId).targetId : "";
    try {
      const { frameTree } = await send("Page.getFrameTree");
      for (const frameId of localFrames(frameTree)) out.push({ target, frameId, send });
    } catch (_) {
      // The frame went away between the two calls.
    }
  }
  return out;
}

// One node of the tree as a line, with its state.
function nodeLine(ref, n) {
  const role = axRole(n), name = axName(n);
  const value = n.value && n.value.value !== undefined ? String(n.value.value) : "";
  const flags = ["checked", "disabled", "expanded", "selected", "required"].filter((p) => axProp(n, p) && axProp(n, p) !== "false");
  return `${ref ? `[${ref}] ` : ""}${role}${name ? ` "${name}"` : ""}${value ? ` = "${value.slice(0, 80)}"` : ""}${flags.length ? ` (${flags.join(", ")})` : ""}`;
}

// Read the page: lines for the model, and what each reference points at. text: also the page's words.
async function readTree(page, text) {
  const lines = [], refs = new Map();
  let acts = 0;
  for (const frame of await allFrames(page)) {
    let nodes = [];
    try {
      nodes = (await frame.send("Accessibility.getFullAXTree", { frameId: frame.frameId })).nodes;
    } catch (_) {
      // A frame without a tree, such as one still loading.
      continue;
    }
    for (const n of nodes) {
      if (n.ignored || n.backendDOMNodeId === undefined) continue;
      const role = axRole(n), name = axName(n);
      if (ACT_ROLES.has(role)) {
        acts++;
        const ref = `e${acts}`;
        refs.set(ref, { target: frame.target, frameId: frame.frameId, node: n.backendDOMNodeId, role, name });
        lines.push(nodeLine(ref, n));
      } else if (name && (role === "heading" || (text && TEXT_ROLES.has(role)))) lines.push(nodeLine("", n));
    }
  }
  return { lines, refs, acts };
}

// What a page shows when its tree is empty: a canvas fills it, or Flutter waits to be asked for semantics.
async function emptyPageKind(page) {
  const { frameTree } = await page.send("Page.getFrameTree");
  const { executionContextId } = await page.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "jw-agent" });
  const { result } = await page.send("Runtime.evaluate", {
    contextId: executionContextId,
    returnByValue: true,
    expression: `(() => {
      const flutter = document.querySelector("flt-semantics-placeholder");
      if (flutter) { flutter.click(); return "flutter"; }
      const big = [...document.querySelectorAll("canvas")].some((c) => c.getBoundingClientRect().width * c.getBoundingClientRect().height > 0.3 * innerWidth * innerHeight);
      return big ? "canvas" : "empty";
    })()`,
  });
  return result.value || "empty";
}

// The sender of the session that holds a target ("" = the tab itself), or null when it is gone.
function senderOf(page, target) {
  if (!target) return page.send;
  for (const [sessionId, s] of page.sessions) if (s.targetId === target) return senderFor(page.tabId, sessionId);
  return null;
}

// Find a reference; when the page changed under it, the same role and name still count if only one matches.
async function resolveRef(page, ref) {
  const known = (pageRefs.get(page.tabId) || new Map()).get(ref);
  if (!known) return { gone: true };
  const send = senderOf(page, known.target);
  if (send) {
    try {
      await send("DOM.describeNode", { backendNodeId: known.node });
      return { ...known, send, moved: false };
    } catch (_) {
      // The node is gone: look for it below.
    }
  }
  const { refs } = await readTree(page, false);
  pageRefs.set(page.tabId, refs);
  const same = [...refs.values()].filter((r) => r.role === known.role && r.name === known.name);
  if (same.length !== 1) return { gone: true, role: known.role, name: known.name };
  return { ...same[0], send: senderOf(page, same[0].target), moved: true };
}

// Where a cross-site frame sits in the page: the content boxes of its owners, added up.
async function frameOffset(page, target) {
  const at = { x: 0, y: 0 };
  let current = target;
  while (current) {
    const entry = [...page.sessions.values()].find((s) => s.targetId === current);
    if (!entry) break;
    const parent = entry.parent ? senderFor(page.tabId, entry.parent) : page.send;
    const { backendNodeId } = await parent("DOM.getFrameOwner", { frameId: current });
    const { model } = await parent("DOM.getBoxModel", { backendNodeId });
    at.x += model.content[0];
    at.y += model.content[1];
    current = entry.parent ? page.sessions.get(entry.parent).targetId : "";
  }
  return at;
}

// The node's centre in the tab's coordinates, after bringing it into view; null when it has no box.
async function nodeCentre(page, hit) {
  await hit.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: hit.node }).catch(() => {});
  const { model } = await hit.send("DOM.getBoxModel", { backendNodeId: hit.node }).catch(() => ({ model: null }));
  if (!model || model.width < 2 || model.height < 2) return null;
  const q = model.border, at = await frameOffset(page, hit.target);
  return { x: at.x + (q[0] + q[2] + q[4] + q[6]) / 4, y: at.y + (q[1] + q[3] + q[5] + q[7]) / 4 };
}

// Run a function on the node in an isolated world of its frame, so the page's own scripts are not touched.
async function onNode(hit, source) {
  const { executionContextId } = await hit.send("Page.createIsolatedWorld", { frameId: hit.frameId, worldName: "jw-agent" });
  const { object } = await hit.send("DOM.resolveNode", { backendNodeId: hit.node, executionContextId });
  const r = await hit.send("Runtime.callFunctionOn", { objectId: object.objectId, returnByValue: true, functionDeclaration: source });
  return r.result ? r.result.value : undefined;
}

// Turn the wheel over the middle of the page.
async function wheelPage(page, dy) {
  const { cssLayoutViewport: vp } = await page.send("Page.getLayoutMetrics");
  const x = Math.round(vp.clientWidth / 2), y = Math.round(vp.clientHeight / 2);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy || vp.clientHeight });
}

// What a scroll can change: where the view is, and which controls exist.
async function viewState(page) {
  const { cssVisualViewport: view } = await page.send("Page.getLayoutMetrics");
  return `${view.pageY}\n${(await readTree(page, false)).lines.join("\n")}`;
}

// Wait for the view to change, for lazy content: back as soon as it does, and no later than the limit.
async function untilChanged(page, before) {
  for (let waited = 0; waited < SETTLE_MS; waited += SETTLE_STEP) {
    await sleep(SETTLE_STEP);
    if ((await viewState(page)) !== before) return true;
  }
  return false;
}

// Wait for an input to finish, or for a dialog it opened: a dialog holds the input's answer back.
function untilDialog(page, input) {
  return Promise.race([input.catch((e) => { if (!page.dialog) throw e; }), page.opened]);
}

// Pointer to a point in one step.
async function pointerTo(page, x, y) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  mouse.set(page.tabId, { x: Math.round(x), y: Math.round(y) });
}

// Focus the node without a mouse press, and say what it is.
const FOCUS_FN = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;
  el.focus({ preventScroll: true });
  const root = el.getRootNode();
  return { native: el.matches("a[href],button,summary,input,select,textarea"), focused: (root.activeElement || document.activeElement) === el, href: el.tagName === "A" ? el.href : "", blank: el.tagName === "A" && (el.target === "_blank" || el.target === "_new") };
}`;

// Activate a node, never raising the window: a mouse click when it is in front, else keyboard or the node's click.
async function activateNode(page, hit, at) {
  await pointerTo(page, at.x, at.y);
  if (await inFront(page.tabId)) {
    await untilDialog(page, clickHere(page.send, page.tabId));
    return "click";
  }
  const f = await onNode(hit, FOCUS_FN).catch(() => null);
  // A link that would open a new tab, which raises the window: opened here instead.
  if (f && f.blank && /^https?:/.test(f.href)) {
    await chrome.tabs.update(page.tabId, { url: f.href });
    return "link";
  }
  // Only native controls answer Enter.
  if (f && f.focused && f.native) {
    await untilDialog(page, pressKey(page.send, "Enter"));
    return "keyboard";
  }
  // A block with a click handler.
  await untilDialog(page, onNode(hit, "function () { (this.nodeType === 1 ? this : this.parentElement).click(); }"));
  return "script";
}

// The tab after an action, with whether the page's controls changed.
async function afterAction(page, before, nav, route, extra, run) {
  // A tab the action opened is the session's too, and closes with it.
  if (nav.newTab !== null && nav.newTab !== undefined) {
    const reg = await registry();
    reg.tabs[nav.newTab] = { run: run || "", created: Date.now() };
    await saveRegistry(reg);
  }
  const info = await tabInfo(page.tabId, nav.timedOut);
  let changed = nav.navigated;
  // A page that navigated has a tree of its own; the read needs no comparison then.
  if (!nav.navigated && !page.dialog) {
    const { lines } = await readTree(page, false);
    changed = lines.join("\n") !== before;
  }
  return { ...info, route, changed, newTab: nav.newTab, dialog: page.dialog, ...extra };
}

// One action on a reference: find it, run act(hit, at), and report; a missing target says why.
async function onRef(msg, act, wantBox = true, navWait = 0) {
  await ownTab(msg.tab);
  // Only what can lead away waits for that to start.
  const watch = watchNavigation(msg.tab, navWait, msg.load_ms);
  return withPage(msg.tab, async (page) => {
    const before = (await readTree(page, false)).lines.join("\n");
    const hit = await resolveRef(page, msg.ref);
    if (hit.gone) {
      await watch.wait();
      return { missing: true, role: hit.role || "", name: hit.name || "" };
    }
    const at = wantBox ? await nodeCentre(page, hit) : null;
    if (wantBox && !at) {
      await watch.wait();
      return { missing: true, hidden: true, role: hit.role, name: hit.name };
    }
    const result = await act(page, hit, at);
    if (result && result.refused) {
      await watch.wait();
      return result;
    }
    const nav = await watch.wait();
    return afterAction(page, before, nav, result.route, { ...result, moved: hit.moved }, msg.run);
  });
}

Object.assign(OPS, {
  // Read the page. {tab, text, limit} → {url, title, lines, truncated, kind}.
  async page_read(msg) {
    await ownTab(msg.tab);
    return withPage(msg.tab, async (page) => {
      let read = await readTree(page, !!msg.text);
      let kind = "page";
      // Nothing to act on: the program decides what comes next from the kind.
      if (read.acts === 0) {
        kind = await emptyPageKind(page);
        // Flutter draws its tree once asked.
        if (kind === "flutter") {
          await sleep(800);
          read = await readTree(page, !!msg.text);
          kind = read.acts > 0 ? "page" : "canvas";
        }
        // Words and no controls is an ordinary page.
        if (kind === "empty" && read.lines.length > 0) kind = "page";
      }
      pageRefs.set(msg.tab, read.refs);
      const limit = Math.min(msg.limit || READ_LIMIT, READ_LIMIT);
      const all = read.lines.join("\n");
      return { ...(await tabInfo(msg.tab, false)), lines: all.slice(0, limit), truncated: all.length > limit, kind, acts: read.acts, dialog: page.dialog };
    });
  },
  // Act on a reference. {tab, ref} → the tab, the route and whether the page changed.
  async page_click(msg) {
    return onRef(msg, async (page, hit, at) => ({ route: await activateNode(page, hit, at) }), true, NAV_WAIT);
  },
  // Rest the pointer on a reference, for menus that open on hover. {tab, ref}.
  async page_hover(msg) {
    return onRef(msg, async (page, _hit, at) => {
      await pointerTo(page, at.x, at.y);
      // The menu needs a moment to open.
      await sleep(300);
      return { route: "hover" };
    });
  },
  // What a field is, before the program lets anything be typed into it. {tab, ref} → {type, role, name}.
  async page_field(msg) {
    await ownTab(msg.tab);
    return withPage(msg.tab, async (page) => {
      const hit = await resolveRef(page, msg.ref);
      if (hit.gone) return { missing: true };
      const type = await onNode(hit, "function () { return this.type || ''; }").catch(() => "");
      return { type, role: hit.role, name: hit.name };
    });
  },
  // Put text into a field, rich editors too, and read it back. {tab, ref, text, clear, enter}.
  async page_type(msg) {
    return onRef(msg, async (page, hit) => {
      const f = await onNode(hit, FOCUS_FN);
      if (!f || !f.focused) return { refused: true, reason: "not-focusable" };
      if (msg.clear) await onNode(hit, "function () { if (this.select) this.select(); else document.execCommand('selectAll'); }");
      await page.send("Input.insertText", { text: String(msg.text ?? "") });
      if (msg.enter) await untilDialog(page, pressKey(page.send, "Enter"));
      if (page.dialog) return { route: "insert", holds: true };
      const shown = await onNode(hit, "function () { return String(this.value ?? this.innerText ?? ''); }").catch(() => "");
      return { route: "insert", holds: shown.includes(String(msg.text ?? "")) };
    }, false, msg.enter ? NAV_WAIT : 0);
  },
  // Choose in a native select by its visible text or value. {tab, ref, option}.
  async page_select(msg) {
    return onRef(msg, async (_page, hit) => {
      const done = await onNode(hit, `function () {
        if (this.tagName !== "SELECT") return false;
        const want = ${JSON.stringify(String(msg.option ?? ""))};
        const o = [...this.options].find((x) => x.text.trim() === want || x.value === want);
        if (!o) return false;
        this.value = o.value;
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }`);
      return done ? { route: "select" } : { refused: true, reason: "not-a-native-option" };
    }, false);
  },
  // Press a key in the focused control. {tab, key}.
  async page_key(msg) {
    await ownTab(msg.tab);
    const watch = watchNavigation(msg.tab, msg.key === "Enter" ? NAV_WAIT : 0, msg.load_ms);
    return withPage(msg.tab, async (page) => {
      const before = (await readTree(page, false)).lines.join("\n");
      await untilDialog(page, pressKey(page.send, msg.key));
      return afterAction(page, before, await watch.wait(), "key", {}, msg.run);
    });
  },
  // Scroll the page by pixels, or a reference into view. {tab, ref, dy}.
  async page_scroll(msg) {
    await ownTab(msg.tab);
    return withPage(msg.tab, async (page) => {
      const before = await viewState(page);
      if (msg.ref) {
        const hit = await resolveRef(page, msg.ref);
        if (hit.gone) return { missing: true, role: hit.role || "", name: hit.name || "" };
        await hit.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: hit.node });
      } else {
        await wheelPage(page, msg.dy);
      }
      const changed = await untilChanged(page, before);
      return { ...(await tabInfo(msg.tab, false)), route: "scroll", changed };
    });
  },
  // Press on one reference and let go on another, with the window in front only: a press behind it raises it.
  async page_drag(msg) {
    return onRef(msg, async (page, hit, from) => {
      if (!(await inFront(page.tabId))) return { refused: true, reason: "needs-front" };
      const to = await resolveRef(page, msg.to);
      const end = to.gone ? null : await nodeCentre(page, to);
      if (!end) return { refused: true, reason: "no-target" };
      await pointerTo(page, from.x, from.y);
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 8; i++) await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + ((end.x - from.x) * i) / 8, y: from.y + ((end.y - from.y) * i) / 8, button: "left", buttons: 1 });
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", buttons: 0, clickCount: 1 });
      return { route: "drag" };
    });
  },
  // Hand local files to a file input. {tab, ref, files}.
  async page_upload(msg) {
    return onRef(msg, async (_page, hit) => {
      await hit.send("DOM.setFileInputFiles", { backendNodeId: hit.node, files: msg.files || [] });
      return { route: "upload" };
    }, false);
  },
  // A picture of the view or of one reference, at most edge pixels long. {tab, ref, edge} → {data, x, y, width, height, scale}.
  async page_capture(msg) {
    await ownTab(msg.tab);
    return withPage(msg.tab, async (page) => {
      const { cssVisualViewport: view } = await page.send("Page.getLayoutMetrics");
      let box = { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight };
      if (msg.ref) {
        const hit = await resolveRef(page, msg.ref);
        if (hit.gone) return { missing: true, role: hit.role || "", name: hit.name || "" };
        await hit.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: hit.node }).catch(() => {});
        const { model } = await hit.send("DOM.getBoxModel", { backendNodeId: hit.node });
        const at = await frameOffset(page, hit.target);
        const after = (await page.send("Page.getLayoutMetrics")).cssVisualViewport;
        box = { x: after.pageX + at.x + model.border[0], y: after.pageY + at.y + model.border[1], width: model.width, height: model.height };
      }
      const scale = Math.min(1, (msg.edge || 1024) / Math.max(box.width, box.height));
      const { data } = await page.send("Page.captureScreenshot", { format: "jpeg", quality: 70, clip: { ...box, scale } });
      return { data, mimeType: "image/jpeg", ...box, scale, url: (await tabInfo(msg.tab, false)).url };
    });
  },
  // Activate what is at a point of the page. {tab, x, y}.
  async page_point(msg) {
    await ownTab(msg.tab);
    const watch = watchNavigation(msg.tab, NAV_WAIT, msg.load_ms);
    return withPage(msg.tab, async (page) => {
      const before = (await readTree(page, false)).lines.join("\n");
      const { cssVisualViewport: view } = await page.send("Page.getLayoutMetrics");
      const at = { x: msg.x - view.pageX, y: msg.y - view.pageY };
      const { backendNodeId, frameId } = await page.send("DOM.getNodeForLocation", { x: Math.round(at.x), y: Math.round(at.y) });
      const route = await activateNode(page, { node: backendNodeId, frameId, send: page.send, target: "" }, at);
      return afterAction(page, before, await watch.wait(), route, {}, msg.run);
    });
  },
  // Answer a page dialog. {tab, accept, text}.
  async page_dialog(msg) {
    await ownTab(msg.tab);
    const page = heldDialogs.get(msg.tab);
    if (!page) return { missing: true, reason: "no-dialog" };
    await page.send("Page.handleJavaScriptDialog", { accept: !!msg.accept, promptText: msg.text || "" });
    await letGo(page);
    return { ...(await tabInfo(msg.tab, false)), route: "dialog", changed: true };
  },
  // The dedicated window's tabs. {run} → {tabs: [{tab, url, title}]}.
  async page_tabs(msg) {
    const reg = await registry();
    const tabs = [];
    for (const [id, rec] of Object.entries(reg.tabs)) {
      if (msg.run && rec.run !== msg.run) continue;
      const t = await chrome.tabs.get(Number(id)).catch(() => null);
      if (t) tabs.push({ tab: t.id, url: t.url || "", title: t.title || "" });
    }
    return { tabs };
  },
  // Run code once in the page, in an isolated world unless main is set; the last expression is the result.
  // {tab, code, main, timeout_ms} → {value, error, truncated}.
  async page_eval(msg) {
    await ownTab(msg.tab);
    return withPage(msg.tab, async (page) => {
      const params = { expression: String(msg.code ?? ""), replMode: true, awaitPromise: true, returnByValue: true, timeout: msg.timeout_ms || 15000 };
      if (!msg.main) {
        const { frameTree } = await page.send("Page.getFrameTree");
        const { executionContextId } = await page.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "jw-eval" });
        params.contextId = executionContextId;
      }
      const { result, exceptionDetails } = await page.send("Runtime.evaluate", params);
      if (exceptionDetails) {
        const text = (exceptionDetails.exception && exceptionDetails.exception.description) || exceptionDetails.text;
        return { error: String(text).slice(0, 2000) };
      }
      const shown = result.value === undefined ? String(result.description ?? "undefined") : typeof result.value === "string" ? result.value : JSON.stringify(result.value);
      return { value: shown.slice(0, EVAL_LIMIT), truncated: shown.length > EVAL_LIMIT };
    });
  },
});

// A tab that closes takes its held dialog with it.
chrome.tabs.onRemoved.addListener((tabId) => {
  const page = heldDialogs.get(tabId);
  if (page) letGo(page);
});
