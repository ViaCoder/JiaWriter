// search_fetch bridge page script: scroll height + 40 per link — grows when an infinite-scroll
// engine appends results without changing the URL. From search.py _content_extent.
(() => { const se = document.scrollingElement || document.documentElement;
  return (se ? se.scrollHeight : 0) + document.querySelectorAll("a").length * 40; })();
