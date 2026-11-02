// search_fetch bridge page script: click the element observe.js remembered as window.__sfArgs.id
// (scrolled to the centre first). false when it is gone. From browser.py _act("click").
(() => { const id = (window.__sfArgs || {}).id;
  const e = id ? (window.__waEls || {})[id] : null;
  if (!e) return false;
  e.scrollIntoView({ block: "center", inline: "center" });
  e.click();
  return true; })();
