// JiaWriter page script: the organic results of a Bing, Google, Baidu or Sogou results page.
// window.__sfArgs.engine is "bing", "google", "baidu" or "sogou". Each result anchor is remembered as window.__waEls["r<n>"]
// in the extension's isolated world (the page's DOM is not changed and the page cannot see it), so a
// later click can find it. Returns JSON {results:[{u,t,s,r}], next, challenge, consent, url}.
(() => {
  // Which engine.
  const engine = (window.__sfArgs || {}).engine || "";
  // One line of text.
  const one = (e) => (e ? (e.innerText || "").replace(/\s+/g, " ").trim() : "");
  // Remembered elements of this page (isolated world); earlier result entries are dropped.
  const els = (window.__waEls = window.__waEls || {});
  for (const k of Object.keys(els)) if (k[0] === "r") delete els[k];
  // Ads and side blocks never count as results.
  const JUNK = ".b_ad,.b_adTop,.b_adBottom,#b_context,.b_rs,#tads,#tadsb,#bottomads,#rhs,[data-text-ad],"
    + ".ec_tuiguang,.ec-tuiguang,[data-tuiguang],#content_right,#rs,#rs_top,.rs-link,[class*='related-search']";
  // Baidu and Sogou mark a sponsored entry with a small label inside it.
  const BADGE = new Set(["广告", "品牌广告", "推广", "赞助"]);
  const badged = (box) => [...box.querySelectorAll("span,a,i,em,div")].slice(0, 15).some((e) => BADGE.has((e.innerText || "").trim()));
  // Collected results.
  const out = [];
  // Addresses already taken.
  const seen = new Set();
  // Add one result.
  // url: the real address when the page states it next to a wrapped link (Baidu's mu, Google's data-href).
  const add = (a, title, snippet, url) => {
    const u = (/^https?:\/\//.test(url || "") ? url : "") || (a && a.href) || "";
    if (!/^https?:\/\//.test(u) || !title || seen.has(u) || a.closest(JUNK)) return;
    seen.add(u);
    els[`r${out.length}`] = a;
    out.push({ u, t: title.slice(0, 200), s: snippet.slice(0, 400), r: out.length });
  };
  if (engine === "bing") {
    // Bing: one li.b_algo per result, title link in h2.
    for (const li of document.querySelectorAll("#b_results > li.b_algo")) {
      const a = li.querySelector("h2 a");
      const cap = li.querySelector(".b_caption p, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4, .b_paractl, .b_algoSlug, p");
      add(a, one(a), one(cap));
    }
  } else if (engine === "baidu") {
    // Baidu: one div.c-container (or div.result) per result in #content_left, title link in h3.
    for (const box of document.querySelectorAll("#content_left > div.c-container, #content_left > div.result, #content_left > div.result-op")) {
      const a = box.querySelector("h3 a");
      if (!a || badged(box)) continue;
      const cap = box.querySelector("[class*='content-right'], [class*='summary'], .c-abstract, [class*='text_']");
      // The container's mu attribute holds the real address behind Baidu's /link?url= wrapper; Baidu's own
      // modules carry placeholder hosts there (nourl.*, *.recommend_list.*), which are left out.
      const mu = box.getAttribute("mu") || "";
      add(a, one(a), one(cap), /^https?:\/\/(nourl\.|[^/]*recommend_list\.)/.test(mu) ? "" : mu);
    }
  } else if (engine === "sogou") {
    // Sogou: div.vrwrap / div.rb blocks in .results, title link in h3.
    for (const box of document.querySelectorAll(".results > div.vrwrap, .results > div.rb, .results > div")) {
      const a = box.querySelector("h3 a");
      if (!a || badged(box)) continue;
      const cap = box.querySelector(".space-txt, .text-layout, .str_info, [class*='str-text'], p");
      // A /link wrapper: the block's data-url holds the real address (2026-11-03); search pages and Sogou's own are skipped.
      const real = /\/link$/.test(new URL(a.href, location.href).pathname)
        ? [...box.querySelectorAll("[data-url]")].map((d) => d.getAttribute("data-url") || "").find((u) => /^https?:\/\//.test(u) && !/^https?:\/\/([^/]*\.)?(sogou\.com|so\.html5\.qq\.com)\//.test(u))
        : "";
      add(a, one(a), one(cap), real);
    }
  } else if (engine === "google") {
    // Google: the title is an h3 inside the result link.
    for (const h of document.querySelectorAll("#search a h3, #rso a h3")) {
      const a = h.closest("a");
      const box = a.closest("div.MjjYud, div.g, div[data-hveid], div[data-sokoban-container]") || a.parentElement;
      const cap = box ? box.querySelector(".VwiC3b, [data-sncf], div[style*='-webkit-line-clamp']") : null;
      // data-href holds the real address when href is a /url redirect.
      add(a, one(h), one(cap), a.getAttribute("data-href"));
    }
  }
  // Fallback for a changed layout: titled links in headings inside the main results area.
  if (out.length === 0) {
    const scope = document.querySelector("#b_results, #search, #rso, #content_left, .results, main, [role=main]") || document.body;
    for (const h of scope.querySelectorAll("h2, h3")) {
      const a = h.closest("a") || h.querySelector("a");
      if (a) add(a, one(h), "");
    }
  }
  // Next-page control on screen.
  const next = !!document.querySelector("a.sb_pagN, a[title='Next page'], a[title='下一页'], #pnnext, a[aria-label='Next page'], a[aria-label='下一页'], #sogou_next, #page a[class*='next']")
    // Baidu and Sogou pagers: a link labelled 下一页 (Baidu's label has an empty innerText, so textContent too).
    || [...document.querySelectorAll("#page a, #pagebar_container a, .p a")].some((a) => /^\s*下一页/.test(a.innerText || a.textContent || ""));
  // A bot check instead of results.
  const text = (document.body ? document.body.innerText : "").slice(0, 3000).toLowerCase();
  const challenge = /\/sorry\/|\/antispider/.test(location.pathname) || /^wappass\.baidu\.com$/.test(location.host) || !!document.querySelector("#captcha-form, form[action*='sorry'], #b_captcha, iframe[src*='captcha'], iframe[src*='challenges.cloudflare'], .g-recaptcha")
    || /unusual traffic|异常流量|verify you are human|请验证您是真人|are you a robot|百度安全验证|请完成下方验证|异常访问请求|请输入验证码/.test(text);
  // A cookie consent dialog in front of the page.
  const consent = !!document.querySelector("#bnp_btn_accept, #L2AGLb, form[action*='consent'] button, button[aria-label*='Accept all'], button[aria-label*='全部接受']");
  // The report.
  return JSON.stringify({ results: out, next, challenge, consent, url: location.href });
})()
