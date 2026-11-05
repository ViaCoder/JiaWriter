// JiaWriter page script: what a page is made of, without reading its words. Used to tell a page that stands in
// the way (a bot check, a login) from the page asked for: walls differ in wording, not in make-up.
// Returns JSON. Reads only; changes nothing on the page.
(() => {
  // Host of an address, "" when it has none.
  const host = (u) => {
    try {
      return new URL(u, location.href).hostname;
    } catch (_) {
      return "";
    }
  };
  // Unique hosts of a list of elements' addresses.
  const hosts = (sel, attr) => [...new Set([...document.querySelectorAll(sel)].map((e) => host(e.getAttribute(attr) || "")).filter(Boolean))];
  // The response this document came with.
  const nav = performance.getEntriesByType("navigation")[0];
  const text = document.body ? document.body.innerText || "" : "";
  const links = [...document.querySelectorAll("a[href]")].filter((a) => /^https?:/.test(a.href));
  return JSON.stringify({
    url: location.href,
    title: document.title || "",
    status: nav ? nav.responseStatus : 0,
    textLen: text.length,
    elements: document.querySelectorAll("*").length,
    links: links.length,
    siteLinks: links.filter((a) => host(a.href) === location.hostname).length,
    images: document.images.length,
    forms: document.forms.length,
    inputs: document.querySelectorAll("input:not([type=hidden])").length,
    passwords: document.querySelectorAll("input[type=password]").length,
    iframes: hosts("iframe[src]", "src"),
    scripts: hosts("script[src]", "src"),
    noindex: !!document.querySelector('meta[name="robots"][content*="noindex" i]'),
    refresh: !!document.querySelector('meta[http-equiv="refresh" i]'),
    excerpt: text.replace(/\s+/g, " ").trim().slice(0, 100),
  });
})()
