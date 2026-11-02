// search_fetch bridge page script: type window.__sfArgs.text into the remembered field and submit
// its form (requestSubmit, else an Enter key event); without text it only submits (press_enter). From browser.py _act.
(() => { const a = window.__sfArgs || {};
  const e = a.id ? (window.__waEls || {})[a.id] : null;
  if (!e) return false;
  e.focus();
  const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  if (a.text !== undefined && a.text !== null) {
    Object.getOwnPropertyDescriptor(proto, "value").set.call(e, String(a.text));
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (a.submit === false) return true;
  if (e.form && e.form.requestSubmit) { e.form.requestSubmit(); return true; }
  for (const t of ["keydown", "keypress", "keyup"])
    e.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  return true; })();
