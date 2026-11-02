// WriterAgent page script: the page's main text as Markdown. Readability (vendor/Readability.js,
// injected first, Apache-2.0) picks the article; without one the body minus navigation is used.
// Returns JSON {title, byline, published, site, lang, contentType, markdown, article}.
(() => {
  // Longest text returned (characters).
  const MAX = 200000;
  // Elements whose text is never page content.
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "FORM", "NAV", "ASIDE", "FOOTER", "HEADER"]);
  // Block elements that end a paragraph.
  const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "FIGURE", "FIGCAPTION", "DL", "DT", "DD", "UL", "OL", "TABLE", "ADDRESS"]);
  // Inline text of a node, Markdown-marked (links keep their address).
  const inline = (node) => {
    let s = "";
    for (const c of node.childNodes) {
      if (c.nodeType === 3) s += c.nodeValue;
      else if (c.nodeType === 1 && !SKIP.has(c.tagName)) {
        if (c.tagName === "BR") s += "\n";
        else if (c.tagName === "A" && /^https?:/.test(c.href || "")) {
          const label = inline(c).replace(/\s+/g, " ").trim();
          s += label ? `[${label}](${c.href})` : "";
        } else if (c.tagName === "IMG") s += "";
        else s += inline(c);
      }
    }
    return s;
  };
  // Markdown of a subtree, block by block.
  const blocks = (root, out) => {
    for (const c of root.childNodes) {
      if (c.nodeType === 3) {
        // Loose text between blocks.
        const t = c.nodeValue.replace(/\s+/g, " ").trim();
        if (t) out.push(t);
        continue;
      }
      if (c.nodeType !== 1 || SKIP.has(c.tagName)) continue;
      const tag = c.tagName;
      const text = () => inline(c).replace(/[ \t\r\f\v]+/g, " ").replace(/ *\n */g, "\n").trim();
      if (/^H[1-6]$/.test(tag)) {
        // Headings.
        const t = text();
        if (t) out.push(`${"#".repeat(Number(tag[1]))} ${t.replace(/\n/g, " ")}`);
      } else if (tag === "LI") {
        // List items (numbered inside an ordered list).
        const ol = c.parentElement && c.parentElement.tagName === "OL";
        const n = ol ? [...c.parentElement.children].indexOf(c) + 1 : 0;
        const t = text();
        if (t) out.push(`${ol ? `${n}.` : "-"} ${t.replace(/\n+/g, " ")}`);
      } else if (tag === "BLOCKQUOTE") {
        // Quotes.
        const inner = [];
        blocks(c, inner);
        if (inner.length) out.push(inner.join("\n\n").split("\n").map((l) => `> ${l}`).join("\n"));
      } else if (tag === "PRE") {
        // Code and preformatted text.
        out.push("```\n" + (c.innerText || "").replace(/\n+$/, "") + "\n```");
      } else if (tag === "TR") {
        // Table rows as cells joined by bars.
        const cells = [...c.children].map((td) => inline(td).replace(/\s+/g, " ").trim());
        if (cells.some(Boolean)) out.push(`| ${cells.join(" | ")} |`);
      } else if (tag === "P") {
        // Paragraphs.
        const t = text();
        if (t) out.push(t);
      } else if (BLOCK.has(tag) || c.querySelector("p, h1, h2, h3, h4, h5, h6, li, tr, blockquote, pre, div")) {
        // Containers: their blocks.
        blocks(c, out);
      } else {
        // Inline content standing alone.
        const t = text();
        if (t) out.push(t);
      }
    }
    return out;
  };
  // Markdown of a root element.
  const markdown = (root) => blocks(root, []).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  // Readability on a copy (it changes the tree it reads).
  let art = null;
  try {
    // eslint-disable-next-line no-undef
    art = new Readability(document.cloneNode(true), { charThreshold: 300 }).parse();
  } catch (_) {
    art = null;
  }
  // The article when Readability found a real one.
  let md = "";
  let used = false;
  if (art && art.content && (art.textContent || "").trim().length >= 200) {
    const doc = new DOMParser().parseFromString(art.content, "text/html");
    md = markdown(doc.body);
    used = true;
  }
  // Otherwise the body (navigation, headers, footers and forms are skipped).
  if (!md && document.body) md = markdown(document.body);
  // The report.
  return JSON.stringify({
    title: ((art && art.title) || document.title || "").trim(),
    byline: ((art && art.byline) || "").trim(),
    published: ((art && art.publishedTime) || "").trim(),
    site: ((art && art.siteName) || "").trim(),
    lang: (document.documentElement.getAttribute("lang") || "").trim(),
    contentType: document.contentType || "",
    markdown: md.slice(0, MAX),
    article: used,
  });
})()
