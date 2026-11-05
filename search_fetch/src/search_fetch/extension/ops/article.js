// JiaWriter page script: the page's main text as Markdown. Readability (vendor/Readability.js,
// injected first, Apache-2.0) picks the article; when its pick is a small part of what the page shows, the body
// minus navigation is used.
// Hidden text with nothing visible to go with it is left out of the Markdown and returned whole in `filtered`.
// Returns JSON {title, byline, published, site, lang, contentType, markdown, article, filtered}.
(() => {
  // Elements whose text is never page content.
  // (SVG elements report their tag name in lower case: compare in upper case.)
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "FORM", "NAV", "ASIDE", "FOOTER", "HEADER"]);
  // Block elements that end a paragraph.
  const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "FIGURE", "FIGCAPTION", "DL", "DT", "DD", "UL", "OL", "TABLE", "ADDRESS"]);
  // Inline text of a node, Markdown-marked (links keep their address).
  const inline = (node) => {
    let s = "";
    for (const c of node.childNodes) {
      if (c.nodeType === 3) s += c.nodeValue;
      else if (c.nodeType === 1 && !SKIP.has(c.tagName.toUpperCase())) {
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
      if (c.nodeType !== 1 || SKIP.has(c.tagName.toUpperCase())) continue;
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
  // Red, green, blue and alpha of a computed colour.
  const rgba = (c) => {
    const m = (c || "").match(/[\d.]+/g);
    return m && m.length >= 3 ? [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]] : [0, 0, 0, 1];
  };
  // The solid colour behind an element, or null when an image or gradient may be behind its text.
  const backdrop = (e) => {
    for (let n = e; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage !== "none") return null;
      const c = rgba(s.backgroundColor);
      if (c[3] >= 0.95) return c;
    }
    return [255, 255, 255, 1];
  };
  // True when a picture or video lies under the element, as a sibling instead of a background.
  const overMedia = (e) => {
    const r = e.getBoundingClientRect();
    return [...document.querySelectorAll("img, video, canvas")].some((m) => {
      const b = m.getBoundingClientRect();
      return b.left < r.right && r.left < b.right && b.top < r.bottom && r.top < b.bottom;
    });
  };
  // True for text a reader cannot make out: transparent, or in the colour of what is behind it.
  const blends = (e, s) => {
    // Transparent text painted with a gradient or picture is visible.
    if ((s.webkitBackgroundClip || s.backgroundClip) === "text") return false;
    const fill = rgba(s.webkitTextFillColor || s.color);
    if (fill[3] < 0.05) return true;
    const back = backdrop(e);
    if (!back || Math.abs(fill[0] - back[0]) + Math.abs(fill[1] - back[1]) + Math.abs(fill[2] - back[2]) >= 12) return false;
    return !overMedia(e);
  };
  // Names and labels of what a reader opens: accordions, tabs, sliders, "read more".
  const OPENS = /accordion|collaps|tab-?pane|tab-?content|tabpanel|expand|fold|spoiler|read-?more|carousel|slider|swiper|slick/i;
  const OPENER = /展开|全文|更多|阅读|查看|read more|show more|see more|expand/i;
  // True for a closed part of the page that a reader can open.
  const openable = (e) => {
    if (e.closest('details:not([open]), [hidden="until-found"]')) return true;
    for (let n = e, i = 0; n && i < 3; n = n.parentElement, i++) {
      if (OPENS.test(`${n.getAttribute("class") || ""} ${n.getAttribute("role") || ""}`)) return true;
      const id = n.id && CSS.escape(n.id);
      if (id && document.querySelector(`[aria-controls~="${id}"], [href="#${id}"], [data-target="#${id}"], [data-bs-target="#${id}"]`)) return true;
    }
    return [...(e.parentElement ? e.parentElement.children : [])].some(
      (c) => c !== e && (c.textContent || "").length < 20 && OPENER.test(c.textContent || ""),
    );
  };
  // Elements whose text is never painted, or is not page text at all.
  const UNPAINTED = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "SELECT", "OPTION", "BUTTON", "IFRAME", "CANVAS"]);
  // Font size and line height under which text cannot be read (px).
  const TINY = 4;
  // Open area that shows nothing: the classic hidden box is one pixel by one pixel (square px).
  const SLIT = 2;
  // Opacity that shows nothing (0.01 is a known trick).
  const CLEAR = 0.02;
  // Distance from the page root that only a thrown-away box has (px).
  const FAR = 5000;
  // Share of a hidden part that is link text when it is a menu or a list of headlines.
  const LINK_SHARE = 0.5;
  // Text a page must show to be read as a page: less is a page still loading, so nothing is taken out.
  const NEARLY_EMPTY = 200;
  // Share of the visible text below which Readability's pick is a fragment of a list or home page.
  // Jina Reader tests the same 0.3; in nine real pages failures stayed at or under 0.12 and articles at or over 0.43.
  const ARTICLE_SHARE = 0.3;
  // Clip shapes that leave no area.
  const NO_SHAPE = /inset\((50|100)%|circle\(0|ellipse\(0|polygon\(0px 0px\)/;
  // A clip rectangle with the same number four times has no area.
  const NO_CLIP = /rect\((\S+?),? \1,? \1,? \1\)/;
  // Page text direction: a right-to-left page runs off to the left.
  const rtl = getComputedStyle(document.documentElement).direction === "rtl";
  // Visible characters of a text.
  const size = (t) => (t || "").replace(/\s+/g, "").length;
  // True for an overflow value that cuts and offers no scrolling.
  const cuts = (v) => v === "hidden" || v === "clip";
  // Combined opacity of an element and its ancestors, remembered per element.
  const opacities = new Map();
  const opacityOf = (e) => {
    if (!e) return 1;
    if (opacities.has(e)) return opacities.get(e);
    const s = getComputedStyle(e);
    const filter = /opacity\(([\d.]+)(%?)\)/.exec(s.filter);
    const own = parseFloat(s.opacity) * (filter ? parseFloat(filter[1]) / (filter[2] ? 100 : 1) : 1);
    const all = own * opacityOf(e.parentElement);
    opacities.set(e, all);
    return all;
  };
  // True for an element or ancestor placed far out from the page root, remembered per element.
  const thrownAway = new Map();
  const thrown = (e) => {
    if (!e || e === document.body) return false;
    if (thrownAway.has(e)) return thrownAway.get(e);
    const s = getComputedStyle(e);
    const root = !e.offsetParent || e.offsetParent === document.body || e.offsetParent === document.documentElement;
    const far = root && (s.position === "absolute" || s.position === "fixed") && (parseFloat(s.left) >= FAR || parseFloat(s.top) >= FAR);
    const result = far || thrown(e.parentElement);
    thrownAway.set(e, result);
    return result;
  };
  // The nearest box that leaves the text no area, or null. Boxes that scroll are not cuts: a reader scrolls them.
  const cutBy = (rects, e) => {
    for (let n = e; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (NO_SHAPE.test(s.clipPath)) return n;
      if (s.position === "absolute" || s.position === "fixed") if (NO_CLIP.test(s.clip)) return n;
      const across = cuts(s.overflowX);
      const down = cuts(s.overflowY);
      if (!across && !down) continue;
      const b = n.getBoundingClientRect();
      let open = 0;
      for (const r of rects) {
        const w = across ? Math.min(r.right, b.right) - Math.max(r.left, b.left) : r.width;
        const h = down ? Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) : r.height;
        if (w > 0 && h > 0) open += w * h;
      }
      if (open <= SLIT) return n;
    }
    return null;
  };
  // What keeps a text node from a reader: null when it is seen, otherwise {cut}, the box that cuts it if any.
  // The browser answers: laid out or not, where the lines fell, what opacity they ended up with.
  const range = document.createRange();
  const unseen = (node) => {
    const e = node.parentElement;
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    // Not laid out: closed, or never shown.
    if (!rects.length) return { cut: null };
    const s = getComputedStyle(e);
    if (s.visibility !== "visible" || opacityOf(e) < CLEAR) return { cut: null };
    // Skipped by content-visibility: lines are still measured, but never painted. Ask a box: display:contents has none.
    let box = e;
    while (box && getComputedStyle(box).display === "contents") box = box.parentElement;
    if (box && !box.checkVisibility()) return { cut: null };
    const cut = cutBy(rects, e);
    if (cut) return { cut };
    // Off the page where no scrollbar reaches: past the left (on a left-to-right page) or above the top.
    if (rects.every((r) => (!rtl && r.right + scrollX <= 0) || r.bottom + scrollY <= 0)) return { cut: null };
    if (thrown(e)) return { cut: null };
    // Too small to read: set that small, or scaled down to that (only the line height shows a scale).
    if (parseFloat(s.fontSize) < TINY || Math.max(...rects.map((r) => r.height)) < TINY) return { cut: null };
    return blends(e, s) ? { cut: null } : null;
  };
  // True when two elements are the same kind of thing: same tag and a class in common, or plain list items.
  const sameKind = (a, b) => {
    if (a.tagName !== b.tagName) return false;
    if (a.tagName === "LI" || a.tagName === "TR" || a.tagName === "DD") return true;
    return [...a.classList].some((c) => b.classList.contains(c));
  };
  // True when a same-kind neighbour of the parent, one that shows, holds a same-kind part.
  const repeats = (part, shown) => {
    const item = part.parentElement;
    const classes = [...part.classList];
    if (!item?.parentElement || !classes.length) return false;
    const like = `${part.tagName}.${classes.map((c) => CSS.escape(c)).join(", ")}`.replace(/, /g, `, ${part.tagName}.`);
    return [...item.parentElement.children].some((c) => c !== item && shown.has(c) && sameKind(c, item) && c.querySelector(like));
  };
  // True for hidden text that belongs to the page. Pages hide real content all the time: news.cn and gov.cn keep
  // slides off to the side, sina.com.cn keeps 9980 characters in closed tabs. No style tells those from a hidden
  // prompt, their place does: each has something visible it belongs to. A hidden prompt has nothing to go with.
  const belongs = (part, boxes, shown) => {
    // Cut by a box that shows other text: the next slide, the rest of a folded article.
    if (boxes.some((b) => shown.has(b))) return true;
    // A text node hidden inside text that shows: nothing but itself to judge.
    if (part.nodeType === 3) return false;
    // Another of the same kind shows: a list item, a tab, a slide.
    if ([...(part.parentElement ? part.parentElement.children : [])].some((c) => c !== part && shown.has(c) && sameKind(c, part))) return true;
    // Every item of a list hides the same part: a summary that opens on hover (36kr.com). Planted text does not repeat.
    if (repeats(part, shown)) return true;
    // A reader can open it.
    if (openable(part)) return true;
    // Mostly links: a menu or a list of headlines.
    const links = [...part.querySelectorAll("a")].reduce((sum, a) => sum + size(a.textContent), 0);
    return links > size(part.textContent) * LINK_SHARE;
  };
  // A copy of the page without text that belongs to nothing, and that text; the page itself stays as it is.
  const visibleCopy = () => {
    const copy = document.cloneNode(true);
    const live = [...document.querySelectorAll("body *")];
    const twins = copy.querySelectorAll("body *");
    if (live.length !== twins.length) return { page: copy, filtered: [], seen: size(document.body.innerText), linked: 0 };
    // Sort every text node.
    const shown = new Set();
    const hidden = [];
    let seen = 0;
    let linked = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue.trim() || !n.parentElement || UNPAINTED.has(n.parentElement.tagName.toUpperCase())) continue;
      const why = unseen(n);
      if (why) {
        hidden.push([n, why.cut]);
        continue;
      }
      seen += size(n.nodeValue);
      if (n.parentElement.closest("a")) linked += size(n.nodeValue);
      for (let e = n.parentElement; e && !shown.has(e); e = e.parentElement) shown.add(e);
    }
    if (seen < NEARLY_EMPTY) return { page: copy, filtered: [], seen, linked };
    // Hidden text comes in parts: the outermost element holding it and nothing that shows.
    const parts = new Map();
    for (const [n, cut] of hidden) {
      let part = n.parentElement;
      if (shown.has(part)) part = n;
      else while (part.parentElement && !shown.has(part.parentElement)) part = part.parentElement;
      if (!parts.has(part)) parts.set(part, []);
      if (cut) parts.get(part).push(cut);
    }
    // What belongs to nothing leaves the copy, and is returned whole so that nothing is lost.
    const index = new Map(live.map((e, i) => [e, i]));
    const filtered = [];
    for (const [part, boxes] of parts) {
      if (belongs(part, boxes, shown)) continue;
      const text = (part.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const twin = part.nodeType === 3 ? twins[index.get(part.parentElement)]?.childNodes[[...part.parentElement.childNodes].indexOf(part)] : twins[index.get(part)];
      if (!twin) continue;
      twin.remove();
      filtered.push(text);
    }
    // What stayed is meant to be read: Readability drops anything with these marks, so they go.
    for (const e of copy.querySelectorAll("body [style], body [hidden], body [aria-hidden]")) {
      e.style?.removeProperty("display");
      e.style?.removeProperty("visibility");
      e.removeAttribute("hidden");
      e.removeAttribute("aria-hidden");
    }
    return { page: copy, filtered, seen, linked };
  };
  const { page, filtered, seen, linked } = visibleCopy();
  // A page that is mostly links is a list: nine real pages split cleanly, lists at 72-96%, articles at 9-32%.
  const list = linked > seen * LINK_SHARE;
  // Readability on a copy (it changes the tree it reads).
  let art = null;
  try {
    // eslint-disable-next-line no-undef
    const reader = new Readability(page.cloneNode(true), { charThreshold: 300 });
    // This pass drops lists and tables with many links: an article's references went with it (en.wikipedia.org).
    reader._flags &= ~reader.FLAG_CLEAN_CONDITIONALLY;
    art = reader.parse();
  } catch (_) {
    art = null;
  }
  // The article when Readability found a real one.
  let md = "";
  let used = false;
  const picked = art ? size(art.textContent) : 0;
  if (!list && art && art.content && picked >= NEARLY_EMPTY && picked >= seen * ARTICLE_SHARE) {
    const doc = new DOMParser().parseFromString(art.content, "text/html");
    md = markdown(doc.body);
    used = true;
  }
  // Otherwise the body (navigation, headers, footers and forms are skipped).
  if (!md && page.body) md = markdown(page.body);
  // The report.
  return JSON.stringify({
    title: ((art && art.title) || document.title || "").trim(),
    byline: ((art && art.byline) || "").trim(),
    published: ((art && art.publishedTime) || "").trim(),
    site: ((art && art.siteName) || "").trim(),
    lang: (document.documentElement.getAttribute("lang") || "").trim(),
    contentType: document.contentType || "",
    markdown: md,
    article: used,
    filtered,
  });
})()
