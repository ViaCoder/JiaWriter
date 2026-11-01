// search_fetch bridge page script: click an explicit Next link/button (rel=next or Next/下一页/»/›/→),
// skipping settings/login/help controls. From search.py _next_page step 1b.
(() => { const re = /^\s*(next|下一页|下页|后页|next page|»|›|→|>)\s*$/i;
  const bad = /settings|preferences|account|profile|login|sign|register|help|support|about|privacy|terms|设置|偏好|登录|注册|帮助/i;
  for (const e of document.querySelectorAll("a[rel=next],a,button,[role=button]")) {
    const t = (e.innerText || e.getAttribute("aria-label") || "").trim();
    const ctx = t + " " + (e.getAttribute("href") || "") + " " + (e.getAttribute("aria-label") || "");
    if (bad.test(ctx)) continue;
    if (e.getAttribute("rel") === "next" || (t && re.test(t))) { e.scrollIntoView({ block: "center" }); e.click(); return true; } }
  return false; })();
