// Runs in every frame of the page and answers only from the control's own frame: the control's
// box in that frame's viewport px, with keyboard focus given to it on demand. A cross-origin
// control frame is beyond the page's scripts and frame tree, but an all-frames injection still
// reaches it when its host page can see it. 'checkbox' when a real small control is found, else
// 'stage' (the whole control area, whose clickable mark is on the left).
(() => {
  if (!/challenges\.cloudflare\.com/.test(location.href || "")) return null;
  // The real input, when there is one: only it takes keyboard focus and toggles on Space.
  const input = document.querySelector('input[type="checkbox"]') || document.querySelector('[role="checkbox"]');
  const cb = input || document.querySelector(".mark") || document.querySelector(".cb-lb");
  const el = cb || document.querySelector("#challenge-stage") || document.body;
  if (!el) return null;
  if (window.__sfArgs && window.__sfArgs.focus) {
    const t = input || cb;
    try { t.focus({ preventScroll: true }); } catch (_) { t.focus(); }
  }
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return JSON.stringify({ which: cb ? "checkbox" : "stage", x: r.left, y: r.top, w: r.width, h: r.height });
})()
