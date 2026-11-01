// search_fetch bridge page script: click a "More results"/加载更多 button. From search.py _next_page step 2.
(() => { const re = /more results|more result|加载更多|更多结果|show more|^更多$/i;
  const bad = /settings|preferences|account|login|sign|register|help|设置|偏好|登录/i;
  for (const b of document.querySelectorAll("button,a,[role=button]")) {
    const t = (b.innerText || b.getAttribute("aria-label") || "").trim();
    if (t && re.test(t) && !bad.test(t + " " + (b.getAttribute("href") || ""))) { b.scrollIntoView({ block: "center" }); b.click(); return true; } }
  return false; })();
