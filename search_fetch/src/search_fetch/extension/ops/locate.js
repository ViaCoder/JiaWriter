// WriterAgent page script: find the element a click or typing should land on and return its box in
// viewport pixels. window.__sfArgs picks it by one of: wfId (remembered by observe.js, next_link.js or
// more_button.js), ref (a result remembered by serp.js), or selectors (CSS, first visible match) with an
// optional text pattern. Remembered elements live in window.__waEls of the extension's isolated world.
(() => {
  // What to find.
  const a = window.__sfArgs || {};
  // Visible on screen or reachable by scrolling (has a size and is not hidden).
  const shown = (e) => {
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width >= 2 && r.height >= 2 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  // Candidates in document order.
  let list = [];
  const els = window.__waEls || {};
  if (a.wfId) list = els[a.wfId] && els[a.wfId].isConnected ? [els[a.wfId]] : [];
  else if (a.ref !== undefined && a.ref !== null) list = els[`r${a.ref}`] && els[`r${a.ref}`].isConnected ? [els[`r${a.ref}`]] : [];
  else for (const sel of a.selectors || []) { try { list.push(...document.querySelectorAll(sel)); } catch (_) { /* bad selector */ } }
  // Optional text filter on the visible label.
  const re = a.text ? new RegExp(a.text, "i") : null;
  const label = (e) => ((e.innerText || e.value || e.getAttribute("aria-label") || e.getAttribute("title") || "") + "").trim();
  // First match that is shown.
  const el = list.find((e) => shown(e) && (!re || re.test(label(e))));
  if (!el) return { found: false };
  // Its box and the viewport size.
  const r = el.getBoundingClientRect();
  return { found: true, x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, tag: el.tagName.toLowerCase() };
})()
