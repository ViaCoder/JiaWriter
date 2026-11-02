// WriterAgent page script: the organic results of a Bing or Google results page.
// window.__sfArgs.engine is "bing" or "google". Each result anchor is remembered as window.__waEls["r<n>"]
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
  const JUNK = ".b_ad,.b_adTop,.b_adBottom,#b_context,.b_rs,#tads,#tadsb,#bottomads,#rhs,[data-text-ad]";
  // Collected results.
  const out = [];
  // Addresses already taken.
  const seen = new Set();
  // Add one result.
  const add = (a, title, snippet) => {
    const u = (a && a.href) || "";
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
  } else if (engine === "google") {
    // Google: the title is an h3 inside the result link.
    for (const h of document.querySelectorAll("#search a h3, #rso a h3")) {
      const a = h.closest("a");
      const box = a.closest("div.MjjYud, div.g, div[data-hveid], div[data-sokoban-container]") || a.parentElement;
      const cap = box ? box.querySelector(".VwiC3b, [data-sncf], div[style*='-webkit-line-clamp']") : null;
      add(a, one(h), one(cap));
    }
  }
  // Fallback for a changed layout: titled links in headings inside the main results area.
  if (out.length === 0) {
    const scope = document.querySelector("#b_results, #search, #rso, main, [role=main]") || document.body;
    for (const h of scope.querySelectorAll("h2, h3")) {
      const a = h.closest("a") || h.querySelector("a");
      if (a) add(a, one(h), "");
    }
  }
  // Next-page control on screen.
  const next = !!document.querySelector("a.sb_pagN, a[title='Next page'], a[title='下一页'], #pnnext, a[aria-label='Next page'], a[aria-label='下一页']");
  // A bot check instead of results.
  const text = (document.body ? document.body.innerText : "").slice(0, 3000).toLowerCase();
  const challenge = /\/sorry\//.test(location.pathname) || !!document.querySelector("#captcha-form, form[action*='sorry'], #b_captcha, iframe[src*='captcha'], iframe[src*='challenges.cloudflare'], .g-recaptcha")
    || /unusual traffic|异常流量|verify you are human|请验证您是真人|are you a robot/.test(text);
  // A cookie consent dialog in front of the page.
  const consent = !!document.querySelector("#bnp_btn_accept, #L2AGLb, form[action*='consent'] button, button[aria-label*='Accept all'], button[aria-label*='全部接受']");
  // The report.
  return JSON.stringify({ results: out, next, challenge, consent, url: location.href });
})()
