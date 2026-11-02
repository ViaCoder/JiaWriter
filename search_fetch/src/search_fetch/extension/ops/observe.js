// search_fetch bridge page script (page observation for the driver). Runs via chrome.scripting.executeScript; the value of the
// last expression is returned to the sf process. The candidate limit comes from window.__sfArgs.limit. From browser.py _OBSERVE_JS.
(() => {
  const LIMIT = (window.__sfArgs && window.__sfArgs.limit) || 60;
  const vis = e => {
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width >= 4 && r.height >= 4 && r.bottom >= 0 && r.right >= 0 &&
           r.top <= innerHeight + 400 && r.left <= innerWidth + 200 &&
           s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const txt = e => ((e.innerText || e.value || e.getAttribute('aria-label') ||
                     e.placeholder || e.title || '') + '').replace(/\s+/g, ' ').trim().slice(0, 100);
  // Candidates are remembered in window.__waEls of the extension's isolated world (the page's DOM is
  // not changed). Ids from earlier observations are dropped FIRST, so after a scroll an id never
  // points at a stale, top-of-page element (which once made next-page clicks hit a dead element).
  const els = (window.__waEls = window.__waEls || {});
  for (const k of Object.keys(els)) if (k.startsWith('wf')) delete els[k];
  const nodes = [...document.querySelectorAll(
    'input,textarea,button,a,[role="button"],[role="link"],[role="searchbox"],[role="combobox"]')];
  const cands = [];
  for (const e of nodes) {
    if (!vis(e)) continue;
    const id = 'wf' + cands.length;
    els[id] = e;
    // Pagination hints so the driver can target the real next-page control on noisy
    // SERPs instead of guessing (Bing buries it among dozens of '›' glyphs).
    const al = ((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '')).toLowerCase();
    const rel = (e.getAttribute('rel') || '').toLowerCase();
    const tt = (e.innerText || '').trim();
    const nm = (e.getAttribute('name') || '').toLowerCase();
    const ph = (e.getAttribute('placeholder') || '').toLowerCase();
    const role = (e.getAttribute('role') || '').toLowerCase();
    const tag = e.tagName.toLowerCase();
    // Scenario hints — best-effort flags so the driver can target the RIGHT element per moment
    // (search vs next-page vs more-results vs cookie consent) instead of guessing on noisy SERPs.
    const nextish = rel === 'next' ||
                    /next page|下一页|下页|后页|siguiente|suivant|próxima/.test(al) ||
                    /^(>|›|»|→|next|下一页|下页|后页)$/i.test(tt);
    const pagenum = /^\d{1,3}$/.test(tt) ? parseInt(tt, 10) : 0;
    const searchish = (tag === 'input' || tag === 'textarea') &&
                      (/^(q|query|wd|kw|p|text|search|keyword)$/.test(nm) ||
                       /search/.test((e.type || '').toLowerCase()) ||
                       role === 'searchbox' || role === 'combobox' ||
                       /搜索|search|查找|输入/.test(ph + al));
    const moreish = /^(more results|more result|加载更多|更多结果|show more|load more|展开更多|更多)$/i.test(tt) ||
                    /more results|加载更多|show more|load more/.test(al);
    const consentish = /^(accept|accept all|agree|i agree|allow all|got it|ok|同意|全部同意|接受|全部接受|允许|确定)$/i.test(tt) ||
                       /accept all|consent|i agree|同意|接受 cookie/.test(al);
    // AVOID: nav/settings/account links that a click must never land on (the startpage→settings
    // misclick). The driver/pickers skip these and recover (go back) if one is hit anyway.
    const href = (e.getAttribute('href') || '');
    const avoid = /\/(settings|preferences|prefs|account|profile|login|signin|register|signup|help|support|about|legal|privacy|terms|feedback)\b/i.test(href) ||
                  /^(settings|preferences|account|profile|sign in|sign up|log in|login|register|help|support|about|privacy|terms|feedback|设置|偏好|登录|注册|帮助|关于|隐私)$/i.test(tt) ||
                  /\b(settings|preferences|account|sign in|sign up|log ?in|register|feedback)\b|设置|偏好|登录|注册/i.test(al);  // aria-label/title — catches gear ICONS with no text
    cands.push({
      id, tag, type: (e.type || ''),
      role: e.getAttribute('role') || '', name: e.getAttribute('name') || '',
      text: txt(e), placeholder: (e.getAttribute('placeholder') || '').slice(0, 80),
      href: href.slice(0, 120),
      nextish, pagenum, searchish, moreish, consentish, avoid,
    });
    if (cands.length >= LIMIT) break;
  }
  const challengeIframe = !!document.querySelector(
    'iframe[src*="challenges.cloudflare"],iframe[src*="turnstile"],iframe[src*="captcha"],' +
    '.g-recaptcha,.h-captcha,#px-captcha,#challenge-running,#challenge-form');
  // Research-validated CLEARANCE signal (nodriver-cf-verify): Cloudflare writes the Turnstile
  // clearance token into a hidden input#cf-chl-widget-<id>_response once the challenge is solved.
  // A non-empty value means the human (or browser) passed it — a definitive "cleared" signal.
  const cfCleared = [...document.querySelectorAll('input[id^="cf-chl-widget"]')]
    .some(el => el.value && el.value.length > 0);
  const se = document.scrollingElement || document.documentElement || {scrollTop:0, scrollHeight:0};
  const scrollY = Math.round(se.scrollTop || 0), viewH = window.innerHeight || 0,
        scrollH = Math.round(se.scrollHeight || 0);
  const atBottom = (scrollY + viewH) >= (scrollH - 8);
  return JSON.stringify({
    url: location.href, title: document.title || '',
    excerpt: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 800),
    challengeIframe, cfCleared, scrollY, scrollH, viewH, atBottom, elements: cands,
  });
})()
