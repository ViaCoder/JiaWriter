// search_fetch bridge page script: remember (window.__waEls.wfmore, isolated world) a "More results"/加载更多 button; search.py then clicks it with trusted input.
(() => { const re = /more results|more result|加载更多|更多结果|show more|^更多$/i;
  const bad = /settings|preferences|account|login|sign|register|help|设置|偏好|登录/i;
  for (const b of document.querySelectorAll("button,a,[role=button]")) {
    const t = (b.innerText || b.getAttribute("aria-label") || "").trim();
    if (t && re.test(t) && !bad.test(t + " " + (b.getAttribute("href") || ""))) { (window.__waEls = window.__waEls || {}).wfmore = b; return true; } }
  return false; })();
