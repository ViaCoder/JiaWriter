// search_fetch bridge page script: stamp window.__wfLast on any mouse/key/touch event (a person
// working a challenge). Idempotent per page. From browser.py _ACTIVITY_JS.
(() => { if (window.__wfAct) return true; window.__wfAct = 1; window.__wfLast = 0;
  const u = () => { window.__wfLast = Date.now(); };
  for (const ev of ["mousemove", "mousedown", "keydown", "touchstart", "pointerdown"])
    document.addEventListener(ev, u, { capture: true, passive: true });
  return true; })();
