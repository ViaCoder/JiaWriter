// search_fetch bridge page script (page metadata). Runs via chrome.scripting.executeScript; the value of the
// last expression is returned to the sf process. Moved verbatim from fetch.py _META_JS.
(() => {
  const g = (s, a) => { const e = document.querySelector(s); return e ? (e.getAttribute(a) || '').trim() : ''; };
  const desc = g('meta[name="description"]','content') || g('meta[property="og:description"]','content');
  // Publication date, most-authoritative first. The bare time[datetime] fallback is only
  // trusted when it is scoped to the article or UNIQUE on the page — on listing-like pages
  // the first <time> is often a sidebar/related-article stamp, and a wrong page date would
  // poison the recency signal of every chunk of the page downstream.
  const times = document.querySelectorAll('time[datetime]');
  const pub = g('meta[property="article:published_time"]','content') || g('meta[name="date"]','content')
            || g('meta[itemprop="datePublished"]','content') || g('article time[datetime]','datetime')
            || (times.length === 1 ? (times[0].getAttribute('datetime') || '').trim() : '');
  return JSON.stringify({ title: (document.title||'').trim(), desc: desc.slice(0,300), pub,
    lang: (document.documentElement.getAttribute('lang')||'').trim(), final_url: location.href });
})()
