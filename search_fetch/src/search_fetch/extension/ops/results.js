// search_fetch bridge page script (SERP result links). Runs via chrome.scripting.executeScript; the value of the
// last expression is returned to the sf process. From search.py _RESULTS_JS.
(() => {
  // Engines wrap result links in their OWN domain (Bing /ck/a?u=…, Baidu/Sogou
  // /link?url=…) — those resolve to the real page on fetch, so keep them. Only drop
  // genuine nav (the search box / tab links / scripts).
  const skipNav = /\/search\?|javascript:|mailto:|\/preferences|\/settings|accounts\.|login|signin/i;
  // ADS + RECOMMENDED/RELATED blocks — never fetch these. Cross-engine container markers
  // (Bing .b_ad/.b_rs/#b_context, Google #tads/#tadsb/#bottomads/#rhs/.related-question-pair,
  // Baidu .ec_tuiguang/[data-tuiguang]/[mu], Sogou/DDG/Startpage ad+related). The selector is
  // curated (no broad [class*=ad] which would hit 'header'/'shadow').
  const JUNK = '.b_ad,.b_adTop,.b_adBottom,.b_rs,#b_context,.b_ans,[data-text-ad],#tads,#tadsb,' +
    '#bottomads,#rhs,.related-question-pair,.ec_tuiguang,.ec-tuiguang,[data-tuiguang],.ec-ad,' +
    '.result--ad,.badge--ad,.partner,.inline-partner-list,[class*="sponsor"],[class*="tuiguang"],' +
    '#rs,#rs_top,.rs-link,.rs_list,[class*="related-search"],[class*="recommend"],' +
    '[data-placeholder*="广告"],[aria-label="广告"]';
  // Sponsored items carry an explicit AD BADGE inside the result block (Baidu/Sogou render a
  // small 广告/推广 label; reliable even when the ad container class is obfuscated). Scan the
  // enclosing result box for a standalone badge element.
  const BADGE = new Set(['广告', '品牌广告', '推广', '赞助', '广告·', 'ad', 'sponsored', '廣告']);
  const isAd = el => {
    if (el.closest(JUNK)) return true;
    const box = el.closest('div.result,div.c-container,div.result-op,div.vrwrap,div.rb,li,article') || el;
    let n = 0;
    for (const lab of box.querySelectorAll('span,a,i,em,div')) {
      if (++n > 12) break;
      if (BADGE.has((lab.innerText || '').trim().toLowerCase())) return true;
    }
    return false;
  };
  const out = new Map();
  const add = (a, t) => {
    const u = a && a.href || '';
    if (/^https?:\/\//.test(u) && t && t.length >= 6 && !skipNav.test(u) && !isAd(a) && !out.has(u))
      out.set(u, t.slice(0, 90));
  };
  // Pass 1 — result titles in headings (Bing li.b_algo h2 a, Google a>h3, Baidu/Sogou h3 a,
  // DuckDuckGo h2 a). Covers the engines whose titles are heading-wrapped.
  for (const h of document.querySelectorAll('h2, h3, h4')) {
    const a = h.closest('a') || h.querySelector('a');
    if (a) add(a, (h.innerText || '').replace(/\s+/g, ' ').trim());
    // High cap: infinite-scroll engines (Sogou/DDG) accumulate results on ONE page, so a low
    // cap would freeze the count after the first scroll. The caller dedups across captures.
    if (out.size >= 80) break;
  }
  // Pass 2 — fallback for engines that DON'T wrap titles in headings (e.g. Brave uses
  // <a class=…><div class=title>). Only when pass 1 found few: take RESULT-area anchors (not
  // nav/aside/ads/related) with an http(s) href and a real (≥12 char) title.
  if (out.size < 8) {
    const scope = document.querySelector('main, #results, #search, [role=main], #b_results, .react-results') || document.body;
    for (const a of scope.querySelectorAll('a[href^="http"]')) {
      if (a.closest('nav,header,footer,aside,form')) continue;
      const t = (a.innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length >= 12) add(a, t);
      if (out.size >= 80) break;
    }
  }
  return JSON.stringify([...out].map(([u, t]) => ({ u, t })));
})()
