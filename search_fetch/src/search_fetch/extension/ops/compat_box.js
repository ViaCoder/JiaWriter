// The verification control's on-screen rect in the MAIN frame (viewport px), or null.
// Used to translate the control position (measured inside its own frame) into the main frame's
// coordinate space, which is the space CDP Input events expect. Newer widget builds mount their
// <iframe> inside a closed shadow root, where page queries cannot see it; the small host element
// right before the response input is still in the page, and carries the control's on-screen box.
(() => {
  const f = document.querySelector(
    'iframe[src*="challenges.cloudflare.com"],.cf-turnstile iframe,iframe[src*="turnstile"]');
  if (f) {
    const r = f.getBoundingClientRect();
    if (r.width && r.height) return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  // The response input the widget always builds; the element just before it hosts the control.
  const resp = document.querySelector('input[id^="cf-chl-widget"]');
  if (resp) {
    const host = resp.previousElementSibling;
    let el = host && host.getBoundingClientRect && host.getBoundingClientRect().width ? host : resp.parentElement;
    for (let i = 0; i < 3 && el; i++) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) return { left: r.left, top: r.top, width: r.width, height: r.height };
      el = el.parentElement;
    }
  }
  const el = document.querySelector(".cf-turnstile,#cf-turnstile-wrapper,#challenge-stage");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
})()
