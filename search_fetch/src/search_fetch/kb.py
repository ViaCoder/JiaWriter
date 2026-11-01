#!/usr/bin/env python3
"""kb.py — research knowledge base sidecar (inherited from WriterSuite; WriterAgent does not call it).

A vector knowledge base instead of an LLM summarisation step: chunk the raw fetched corpus, embed every chunk with a
mature multilingual embedding model (BAAI/bge-m3 via OpenRouter), and retrieve the
top-k most relevant chunks per framework section — handing the writer the real source
text (with 来源 URLs for citation) instead of a lossy LLM summary.

At ~1K–2K chunks, exact cosine KNN (numpy) is the correct, mature retrieval choice;
heavyweight ANN indexes (FAISS/Chroma) only earn their keep above ~100K vectors. The
mature ML component here is the embedding model, not the index structure.

Subcommands
  index            corpus.txt -> <index_dir>/ (embeddings.npy + meta.json + stats.json)
  retrieve-multi   <index_dir> --queries-json spec.json  (hybrid: multi-query union per section)
  retire           <index_dir> --texts-json used.json  (drop already-used chunks for good)
  query            <index_dir> --query "..." --topk N  (ad-hoc retrieval, debug)

Embeddings: OpenRouter /embeddings, OpenAI-compatible. Key from OPENROUTER_API_KEY (or OPENAI_API_KEY)
(the OpenRouter key), exactly like run.sh — never printed.
"""
import argparse
import base64
import json
import math
import os
import re
import sys
import time
from urllib.parse import parse_qs, unquote, urlencode, urlparse, urlunparse

import numpy as np

try:
    import tiktoken
    _ENC = tiktoken.get_encoding("cl100k_base")
    def ntok(s: str) -> int:
        return len(_ENC.encode(s, disallowed_special=()))
except Exception:  # pragma: no cover - tiktoken always present here
    _ENC = None
    def ntok(s: str) -> int:
        # rough proxy: CJK ~1 char/token, latin ~4 chars/token
        cjk = sum(1 for c in s if "一" <= c <= "鿿")
        return cjk + max(0, (len(s) - cjk)) // 4

import requests

BASE = os.environ.get("WRITERAI_OPENAI_BASE", "https://openrouter.ai/api/v1").rstrip("/")
EMBED_MODEL = os.environ.get("WRITERAI_KB_EMBED_MODEL", "baai/bge-m3")


def _api_key(env) -> str:
    """Embedding key: OPENROUTER_API_KEY (the config.enc name since the 2026-07-20 rename), else OPENAI_API_KEY."""
    # First non-empty of the two names.
    return (env.get("OPENROUTER_API_KEY") or env.get("OPENAI_API_KEY") or "").strip()


# Read once at import, like BASE and EMBED_MODEL.
API_KEY = _api_key(os.environ)
# Exactly ##### — the ONLY form this pipeline's writers emit (fetch corpus assembly,
# ingest.py). Accepting ##–###### let fetched web content containing a heading like
# "## 来源：新华社" forge a page boundary whose non-http "source" then got the WIDE
# local per-source cap reserved for user materials, and mis-attributed citations.
SOURCE_RE = re.compile(r"^#{5}\s*来源[:：]\s*(\S+)", re.M)


def log(*a):
    print("[kb]", *a, file=sys.stderr, flush=True)


# ── Source-URL cleaning ──────────────────────────────────────────────────────
# Search engines hand back redirect/tracking URLs (bing /ck/a?u=a1<base64>,
# duckduckgo /l/?uddg=<enc>, google /url?q=<enc>). Decode them to the real target
# so the writer gets a citable 网址, not engine cruft.

_TRACK_KEYS = {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
               "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ved", "usg", "rut", "ntb"}


def _strip_tracking(url: str) -> str:
    try:
        p = urlparse(url)
        qs = parse_qs(p.query, keep_blank_values=False)
        kept = {k: v for k, v in qs.items()
                if k.lower() not in _TRACK_KEYS and not k.lower().startswith("utm_")}
        newq = urlencode({k: v[0] for k, v in kept.items()})
        return urlunparse((p.scheme, p.netloc, p.path, p.params, newq, ""))
    except Exception:
        return url


def clean_source_url(url: str) -> str:
    try:
        u = url.strip()
        p = urlparse(u)
        host = p.netloc.lower()
        qs = parse_qs(p.query)
        if "bing.com" in host and p.path.startswith("/ck/"):
            raw = qs.get("u", [""])[0]
            if raw.startswith("a1"):
                raw = raw[2:]
            try:
                dec = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode("utf-8", "ignore")
                if dec.startswith("http"):
                    return _strip_tracking(dec)
            except Exception:
                pass
        if "duckduckgo.com" in host and p.path.startswith("/l/"):
            tgt = qs.get("uddg", [""])[0]
            if tgt:
                return _strip_tracking(unquote(tgt))
        if "google." in host and p.path.startswith("/url"):
            tgt = (qs.get("q") or qs.get("url") or [""])[0]
            if tgt.startswith("http"):
                return _strip_tracking(unquote(tgt))
        return _strip_tracking(u)
    except Exception:
        return url


# ── Embedding ────────────────────────────────────────────────────────────────

def embed_batch(texts, model=EMBED_MODEL, max_retries=5):
    """Embed a list of strings via OpenRouter. Returns (np.ndarray[N,dim], usage_dict)."""
    if not API_KEY:
        raise SystemExit("kb: OPENROUTER_API_KEY (or OPENAI_API_KEY) not set")
    url = f"{BASE}/embeddings"
    headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
    payload = {"model": model, "input": texts}
    last_err = None
    for attempt in range(max_retries):
        try:
            r = requests.post(url, headers=headers, json=payload, timeout=120)
            if r.status_code == 200:
                d = r.json()
                rows = sorted(d["data"], key=lambda x: x.get("index", 0))
                vecs = np.array([row["embedding"] for row in rows], dtype=np.float32)
                return vecs, d.get("usage", {})
            last_err = f"HTTP {r.status_code}: {r.text[:200]}"
            # 4xx (except 429) is not transient — a bad key / oversized input fails the
            # same way 5 times; retrying just wastes ~35s of backoff per batch.
            if 400 <= r.status_code < 500 and r.status_code != 429:
                raise SystemExit(f"kb: embedding rejected ({last_err})")
        except Exception as e:  # network hiccup
            last_err = str(e)
        time.sleep(min(2 ** attempt, 20))
    raise SystemExit(f"kb: embedding failed after {max_retries} tries: {last_err}")


def embed_all(texts, model=EMBED_MODEL, batch=48):
    """Embed many texts in batches. Returns (np.ndarray[N,dim], total_usage_dict)."""
    out = []
    total = {"prompt_tokens": 0, "total_tokens": 0, "cost": 0.0, "requests": 0}
    for i in range(0, len(texts), batch):
        chunk = texts[i : i + batch]
        vecs, usage = embed_batch(chunk, model=model)
        out.append(vecs)
        total["prompt_tokens"] += int(usage.get("prompt_tokens", 0) or 0)
        total["total_tokens"] += int(usage.get("total_tokens", 0) or 0)
        total["cost"] += float(usage.get("cost", 0.0) or 0.0)
        total["requests"] += 1
        log(f"embedded {min(i + batch, len(texts))}/{len(texts)} chunks "
            f"(cum cost ${total['cost']:.6f})")
    if not out:
        return np.zeros((0, 1024), dtype=np.float32), total
    return np.vstack(out), total


def normalize(m):
    n = np.linalg.norm(m, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return m / n


# ── Hybrid ranking: BM25 (lexical) + dense, fused by RRF, with recency boost ──
# Dependency-free BM25: ASCII words + CJK character BIGRAMS (works for Chinese without a
# segmenter). Exact terms the embedding misses (dates, names, numbers) rank via BM25;
# paraphrases rank via the dense vectors; RRF fuses the two rank lists.

_ASCII_TOK = re.compile(r"[a-z0-9]{2,}")
_CJK_CHAR = re.compile(r"[\u4e00-\u9fff]")


def bm25_tokenize(text: str):
    t = text.lower()
    toks = _ASCII_TOK.findall(t)
    cjk = _CJK_CHAR.findall(t)
    toks.extend(a + b for a, b in zip(cjk, cjk[1:], strict=False))  # character bigrams
    return toks


class BM25:
    """Okapi BM25 over pre-tokenized docs (k1=1.5, b=0.75)."""

    def __init__(self, docs_tokens, k1=1.5, b=0.75):
        self.k1, self.b = k1, b
        self.n = len(docs_tokens)
        self.doc_len = np.array([len(d) for d in docs_tokens], dtype=np.float64)
        self.avg_len = float(self.doc_len.mean()) if self.n else 1.0
        self.tf = []          # per-doc term freq dicts
        df = {}
        for d in docs_tokens:
            tf = {}
            for tok in d:
                tf[tok] = tf.get(tok, 0) + 1
            self.tf.append(tf)
            for tok in tf:
                df[tok] = df.get(tok, 0) + 1
        self.idf = {t: math.log(1 + (self.n - c + 0.5) / (c + 0.5)) for t, c in df.items()}

    def scores(self, query_tokens):
        out = np.zeros(self.n, dtype=np.float64)
        for tok in set(query_tokens):
            idf = self.idf.get(tok)
            if idf is None:
                continue
            for i, tf in enumerate(self.tf):
                f = tf.get(tok)
                if not f:
                    continue
                denom = f + self.k1 * (1 - self.b + self.b * self.doc_len[i] / self.avg_len)
                out[i] += idf * f * (self.k1 + 1) / denom
        return out


_DATE_PATTERNS = (
    re.compile(r"(20\d{2})[年\-/\.](1[0-2]|0?[1-9])[月\-/\.](3[01]|[12]\d|0?[1-9])"),
    re.compile(r"\b(20\d{2})-(1[0-2]|0[1-9])-(3[01]|[12]\d|0[1-9])\b"),
)


def extract_date(text: str) -> str:
    """Most RECENT plausible YYYY-MM-DD found in the chunk ('' when none) — stored as chunk
    metadata so retrieval can honour the doc-types' timeliness rules (recency boost)."""
    best = ""
    for pat in _DATE_PATTERNS:
        for m in pat.finditer(text):
            iso = f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
            if iso > best:
                best = iso
    return best


# 0.45 (was 0.3): 素材越新越好 — the user wants fresh material to win ties decisively.
# A today-dated chunk scores 1.45× an undated one; relevance still dominates (the boost
# is multiplicative on the fused RRF score, and undated chunks are never penalised below 1.0).
RECENCY_WEIGHT = float(os.environ.get("WRITERAI_KB_RECENCY_WEIGHT", "0.45"))
RECENCY_HALFLIFE_DAYS = float(os.environ.get("WRITERAI_KB_RECENCY_HALFLIFE", "120"))


# The fetch layer opens each browser-fetched page with `（发布时间：YYYY-MM-DD）` when the
# page declares a publication date (fetch._pub_iso). That is the AUTHORITATIVE age of every
# chunk of the page — the newest date mentioned in a chunk's prose (extract_date) may be an
# event date, not the publication date, so the page header wins when present.
# Anchored to the START of the body (the marker is the first line the fetch layer emits)
# so a page's OWN 发布时间 label deeper in its text can't masquerade as the header, and
# month/day are validated so a malformed date can't suppress valid per-chunk prose dates.
_PAGE_PUB_RE = re.compile(
    r"\s*[（(]\s*发布时间[：:]\s*(20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\s*[）)]")


def page_pub_date(body: str) -> str:
    """The page-level publication date from the injected header line ('' when absent)."""
    m = _PAGE_PUB_RE.match(body)
    return m.group(1) if m else ""


def recency_boost(date_iso: str) -> float:
    """1.0 (undated) … 1.0+w (today). Exponential half-life decay over chunk age."""
    if not date_iso or RECENCY_WEIGHT <= 0:
        return 1.0
    try:
        age_days = max(0.0, (time.time() - time.mktime(time.strptime(date_iso, "%Y-%m-%d"))) / 86400.0)
    except Exception:
        return 1.0
    return 1.0 + RECENCY_WEIGHT * (0.5 ** (age_days / RECENCY_HALFLIFE_DAYS))


def rrf_fuse(rank_arrays, k=60):
    """Reciprocal-rank fusion of score arrays → fused score per doc."""
    n = len(rank_arrays[0])
    fused = np.zeros(n, dtype=np.float64)
    for scores in rank_arrays:
        order = np.argsort(-scores)
        ranks = np.empty(n, dtype=np.int64)
        ranks[order] = np.arange(n)
        fused += 1.0 / (k + ranks + 1)
    return fused


# ── Corpus parsing + chunking ────────────────────────────────────────────────

def split_pages(corpus: str):
    """Split the raw corpus into (source_url, body) pages by '##### 来源：URL' markers."""
    pages = []
    marks = list(SOURCE_RE.finditer(corpus))
    if not marks:
        return [("(unknown)", corpus)]
    # any preamble before the first marker is dropped (navigation noise)
    for i, m in enumerate(marks):
        url = clean_source_url(m.group(1).strip())
        start = m.end()
        end = marks[i + 1].start() if i + 1 < len(marks) else len(corpus)
        body = corpus[start:end].strip()
        if body:
            pages.append((url, body))
    return pages


_LINK_RE = re.compile(r"\[([^\]]*)\]\((?:https?://|/|#)[^)]*\)")
_UI_MARKERS = (
    "skip to main", "skip to article", "skip to content", "view pdf",
    "download full", "accept all cookies", "cookie policy", "listen to article",
    "your browser does not support", "subscribe to", "sign in", "log in",
    "add to cart", "share this", "related posts", "table of contents",
)


def prose_density(text: str) -> int:
    """Chars of real prose left after stripping markdown links + list/heading markers.
    Used to drop pure-navigation chunks (link lists, UI chrome) without touching
    substantive content — the embedding relevance ranking does the real filtering."""
    t = _LINK_RE.sub(lambda m: m.group(1), text)          # keep link *labels*, drop urls
    t = re.sub(r"^\s*[#>*\-+\d.]+\s*", "", t, flags=re.M)  # strip bullets/headings markers
    t = re.sub(r"https?://\S+", "", t)                      # bare urls
    return len(t.strip())


_REF_RE = re.compile(
    r"(\bet al\.|\bdoi:|doi\.org/|^\s*\[\d+\]|\bPubMed\b|\bCrossRef\b|"
    r"\b(19|20)\d{2}[a-z]?\)\s*$|, (19|20)\d{2}\b.*\.\s*$)",
    re.I,
)
_SHARE_RE = re.compile(
    r"(twitter\.com/intent|x\.com/intent|wa\.me/|whatsapp|reddit\.com/submit|"
    r"facebook\.com/sharer|linkedin\.com/shar|mailto:|/cdn-cgi/l/email|"
    r"share (on|this)|高清图|download high-res)",
    re.I,
)


def _ratio(lines, pat):
    if not lines:
        return 0.0
    return sum(1 for ln in lines if pat.search(ln)) / len(lines)


def is_boilerplate(text: str, min_prose: int) -> bool:
    low = text.lower()
    ui_hits = sum(1 for m in _UI_MARKERS if m in low)
    lines = [ln for ln in text.splitlines() if ln.strip()]
    link_lines = sum(1 for ln in lines if _LINK_RE.search(ln) and prose_density(ln) < 40)
    link_ratio = link_lines / len(lines) if lines else 0
    prose = prose_density(text)
    if prose < min_prose:
        return True
    if link_ratio > 0.7 and prose < min_prose * 3:
        return True
    if ui_hits >= 2 and prose < min_prose * 2:
        return True
    # reference/bibliography dump: most lines look like citations and little narrative
    if _ratio(lines, _REF_RE) > 0.5 and prose < min_prose * 5:
        return True
    # social-share / email / download-chrome block
    if _ratio(lines, _SHARE_RE) > 0.4 and prose < min_prose * 3:
        return True
    return False


def chunk_page(body: str, chunk_tokens: int, overlap_tokens: int):
    """Greedy paragraph packer with token-overlap. Yields chunk strings."""
    paras = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    chunks, cur, cur_tok = [], [], 0
    for p in paras:
        pt = ntok(p)
        if pt > chunk_tokens and _ENC is not None:
            # hard-split an over-long paragraph by tokens
            if cur:
                chunks.append("\n\n".join(cur))
                cur, cur_tok = [], 0
            ids = _ENC.encode(p, disallowed_special=())
            step = chunk_tokens - overlap_tokens
            for s in range(0, len(ids), step):
                chunks.append(_ENC.decode(ids[s : s + chunk_tokens]))
            continue
        if cur_tok + pt > chunk_tokens and cur:
            chunks.append("\n\n".join(cur))
            # carry overlap: keep trailing paragraphs up to overlap_tokens
            keep, kt = [], 0
            for q in reversed(cur):
                qt = ntok(q)
                if kt + qt > overlap_tokens:
                    break
                keep.insert(0, q)
                kt += qt
            cur, cur_tok = keep[:], kt
        cur.append(p)
        cur_tok += pt
    if cur:
        chunks.append("\n\n".join(cur))
    return [c for c in chunks if c.strip()]


def build_chunks(corpus, chunk_tokens, overlap_tokens, min_chunk_tokens, min_prose=120):
    pages = split_pages(corpus)
    records = []
    dropped = 0
    for pidx, (url, body) in enumerate(pages):
        pub = page_pub_date(body)   # authoritative page date (fetch-injected header), if any
        for cidx, ck in enumerate(chunk_page(body, chunk_tokens, overlap_tokens)):
            if ntok(ck) < min_chunk_tokens:
                continue
            if min_prose > 0 and is_boilerplate(ck, min_prose):
                dropped += 1
                continue
            records.append({"text": ck, "source": url, "page": pidx, "chunk": cidx,
                            "date": pub or extract_date(ck)})
    if dropped:
        log(f"dropped {dropped} low-prose/navigation chunks")
    return records, len(pages)


# ── Retrieval ────────────────────────────────────────────────────────────────

def mmr(query_vec, cand_vecs, k, lambda_mult=0.6):
    """Maximal Marginal Relevance over already-normalized vectors. Returns indices."""
    if cand_vecs.shape[0] == 0:
        return []
    sim_q = cand_vecs @ query_vec
    selected, candidates = [], list(range(cand_vecs.shape[0]))
    while candidates and len(selected) < k:
        if not selected:
            i = int(np.argmax(sim_q[candidates]))
            selected.append(candidates.pop(i))
            continue
        sel_mat = cand_vecs[selected]
        best, best_score = None, -1e9
        for ci in candidates:
            redundancy = float(np.max(cand_vecs[ci] @ sel_mat.T))
            score = lambda_mult * float(sim_q[ci]) - (1 - lambda_mult) * redundancy
            if score > best_score:
                best_score, best = score, ci
        selected.append(best)
        candidates.remove(best)
    return selected


def load_index(index_dir):
    try:
        emb = np.load(os.path.join(index_dir, "embeddings.npy"))
        with open(os.path.join(index_dir, "meta.json"), encoding="utf-8") as f:
            meta = json.load(f)
    except FileNotFoundError:
        # Actionable message for the Rust side instead of a raw traceback
        # (hit via retrieve-multi/query before any index was built).
        raise SystemExit(f"kb: index not found at {index_dir} — run `kb.py index` first") from None
    if len(meta) != emb.shape[0]:
        # Torn write (crash between the two files): retrieving against mismatched
        # rows would return silently WRONG sources — refuse instead.
        raise SystemExit(
            f"kb: index corrupt at {index_dir} ({emb.shape[0]} embeddings vs "
            f"{len(meta)} meta records) — delete the index dir and re-run `kb index`")
    return emb, meta


def source_cap(source: str, per_source: int, per_source_local: int) -> int:
    """Per-source retrieval cap. Web pages (http 来源) keep the tight cap that
    guards against one site flooding a section; LOCAL materials (参考资料/… markers
    from `sf ingest`, or web_search补充) are user-supplied evidence where one file —
    an interview transcript, a report PDF — legitimately carries many chunks, so
    they get the wider cap."""
    return per_source if source.startswith("http") else per_source_local


def retrieve(emb, meta, query, topk, model, per_source=2, per_source_local=8,
             mmr_pool=40, lambda_mult=0.6):
    """Return list of meta records (with 'score') for the query.
    HYBRID: dense cosine + BM25 fused by RRF, then a recency boost from the chunk's
    extracted date, then MMR diversification + per-source caps as before."""
    qv, _ = embed_batch([query], model=model)
    qv = normalize(qv)[0]
    dense = emb @ qv
    bm25 = BM25([bm25_tokenize(r["text"]) for r in meta])
    lexical = bm25.scores(bm25_tokenize(query))
    fused = rrf_fuse([dense, lexical])
    fused *= np.array([recency_boost(r.get("date", "")) for r in meta])
    sims = fused
    pool = np.argsort(-sims)[: max(mmr_pool, topk)]
    pool_vecs = emb[pool]
    order = mmr(qv, pool_vecs, k=min(len(pool), topk * 3), lambda_mult=lambda_mult)
    picked, src_count = [], {}
    for o in order:
        gi = int(pool[o])
        src = meta[gi]["source"]
        if src_count.get(src, 0) >= source_cap(src, per_source, per_source_local):
            continue
        rec = dict(meta[gi])
        rec["score"] = float(sims[gi])
        picked.append(rec)
        src_count[src] = src_count.get(src, 0) + 1
        if len(picked) >= topk:
            break
    return picked


# ── Commands ─────────────────────────────────────────────────────────────────

def append_page_base(old_meta) -> int:
    """First page number for an appended batch: one past the highest existing page,
    so (page, chunk) keys stay unique across incremental ingests."""
    return 1 + max((r.get("page", 0) for r in old_meta), default=0)


def merge_stats(old_stats: dict, npages: int, usage: dict):
    """Fold the previous index's stats.json into the new batch's numbers (pages
    accumulate, usage counters/cost sum) so an --append run reports index TOTALS,
    not batch-only figures. Mutates and returns (npages, usage). Tolerates missing
    keys / null values in an old file; raises on a non-dict (caller treats any
    exception as 'keep new-batch numbers only')."""
    npages += int(old_stats.get("pages", 0) or 0)
    old_usage = old_stats.get("usage", {}) or {}
    for k in ("prompt_tokens", "total_tokens", "requests"):
        usage[k] = usage.get(k, 0) + int(old_usage.get(k, 0) or 0)
    usage["cost"] = usage.get("cost", 0.0) + float(old_usage.get("cost", 0.0) or 0.0)
    return npages, usage


def _register_sources(corpus: str) -> None:
    """Every 来源 source of the corpus (raw + cleaned) joins the run's known-URL ledger
    (SEARCH_FETCH_ONLY_KNOWN_URLS). Best effort: the index never fails over it."""
    try:
        from . import known_urls
    except ImportError:          # run outside the package — no ledger
        return
    try:
        raw = [m.group(1).strip() for m in SOURCE_RE.finditer(corpus)]
        known_urls.register(raw + [clean_source_url(u) for u in raw])
    except Exception as e:
        log(f"known-url ledger not updated: {e}")


def cmd_index(args):
    corpus = open(args.corpus, encoding="utf-8").read()
    _register_sources(corpus)
    records, npages = build_chunks(corpus, args.chunk_tokens, args.overlap_tokens,
                                   args.min_chunk_tokens, args.min_prose)
    log(f"{npages} pages -> {len(records)} chunks "
        f"(chunk={args.chunk_tokens}tok overlap={args.overlap_tokens}tok)")
    if not records:
        raise SystemExit("kb: no chunks produced")
    t0 = time.time()
    emb, usage = embed_all([r["text"] for r in records], model=args.model, batch=args.batch)
    emb = normalize(emb)
    if getattr(args, "append", False) and os.path.exists(os.path.join(args.index, "embeddings.npy")):
        # Incremental ingest: concat onto the existing index (draft-time supplements).
        old_emb, old_meta = load_index(args.index)
        page_base = append_page_base(old_meta)
        for r in records:
            r["page"] = r.get("page", 0) + page_base   # keep (page, chunk) keys unique
        emb = np.concatenate([old_emb, emb], axis=0)
        records = old_meta + records
        log(f"append: index grown to {len(records)} chunks")
        # Merge the previous stats so append doesn't overwrite the totals with new-batch-only
        # numbers (chunks already grew via `records`): pages accumulate, usage counters sum.
        try:
            with open(os.path.join(args.index, "stats.json"), encoding="utf-8") as f:
                old_stats = json.load(f)
            npages, usage = merge_stats(old_stats, npages, usage)
        except Exception:
            pass   # missing/corrupt old stats.json → keep new-batch numbers only
    os.makedirs(args.index, exist_ok=True)
    # tmp + os.replace per file: a crash mid-write must not leave embeddings/meta
    # mismatched (load_index refuses a torn pair, --append would corrupt further).
    emb_path = os.path.join(args.index, "embeddings.npy")
    np.save(emb_path + ".tmp.npy", emb)
    os.replace(emb_path + ".tmp.npy", emb_path)
    meta_path = os.path.join(args.index, "meta.json")
    with open(meta_path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False)
    os.replace(meta_path + ".tmp", meta_path)
    stats = {
        "model": args.model, "pages": npages, "chunks": len(records),
        "dim": int(emb.shape[1]), "embed_seconds": round(time.time() - t0, 1),
        "usage": usage, "chunk_tokens": args.chunk_tokens,
        "overlap_tokens": args.overlap_tokens,
    }
    with open(os.path.join(args.index, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    log(f"indexed {len(records)} chunks, dim={emb.shape[1]}, "
        f"{usage['prompt_tokens']} tok, cost ${usage['cost']:.6f}, "
        f"{stats['embed_seconds']}s")
    print(json.dumps(stats, ensure_ascii=False))


def _char_grams(text: str, n: int = 3) -> frozenset:
    """Character n-gram set (whitespace collapsed) for near-duplicate detection —
    robust for CJK where token-level shingles are unreliable."""
    t = "".join(text.split())
    return frozenset(t[i:i + n] for i in range(max(0, len(t) - n + 1)))


def _near_dup(grams: frozenset, picked_grams: list, threshold: float = 0.65) -> bool:
    """True if ≥threshold of this chunk's n-grams are contained in ANY already-picked
    chunk (containment, not Jaccard: catches a reprint/subset inside a longer chunk).
    Guards the per-section notes against the SAME passage reaching two sections via
    different (page, chunk) keys — reprinted articles, overlap windows, mirrored pages.
    Very short chunks are exempt: formulaic boilerplate (访谈问答 headers, 台账 row
    labels) can hit 65% containment without being the same material."""
    if not grams or len(grams) < 60:
        return False
    for pg in picked_grams:
        if len(grams & pg) / len(grams) >= threshold:
            return True
    return False


def cmd_retrieve_multi(args):
    """Multi-query retrieval: for each section, union the top chunks across SEVERAL queries
    (facets / anticipated sub-points), raising recall/density vs a single section query.
    Input JSON: {"sections":[{"name":..., "queries":[...]}]}. Output JSON: per-section chunks.
    Chunks are EXCLUSIVE across sections — both by (page, chunk) key and by content
    near-duplicate check — so the same material never lands in two sections' notes."""
    emb, meta = load_index(args.index)
    spec = json.load(open(args.queries_json, encoding="utf-8"))
    sections = spec.get("sections", [])
    # Build the lexical index + recency boosts ONCE for all sections.
    bm25 = BM25([bm25_tokenize(r["text"]) for r in meta])
    boosts = np.array([recency_boost(r.get("date", "")) for r in meta])
    # embed every query across all sections in ONE batch
    flat = []
    for s in sections:
        for q in (s.get("queries") or [s.get("name", "")]):
            if q.strip():
                flat.append(q.strip())
    flat = flat or [s.get("name", "") for s in sections]
    qvecs = normalize(embed_batch(flat, model=args.model)[0]) if flat else np.zeros((0, emb.shape[1]), np.float32)
    qidx = {q: i for i, q in enumerate(flat)}

    seen_global = set()
    picked_grams = []   # n-gram sets of every picked chunk, across ALL sections
    out = []
    for s in sections:
        name = s.get("name", "")
        queries = [q.strip() for q in (s.get("queries") or [name]) if q.strip()] or [name]
        cols = [qidx[q] for q in queries if q in qidx]
        if not cols:
            out.append({"name": name, "chunks": [], "markdown": "", "count": 0})
            continue
        sims = emb @ qvecs[cols].T              # [N, |queries|]
        dense_best = sims.max(axis=1)           # best dense sim across this section's queries
        lex = np.zeros(len(meta), dtype=np.float64)
        for q in queries:
            lex = np.maximum(lex, bm25.scores(bm25_tokenize(q)))
        best = rrf_fuse([dense_best, lex]) * boosts
        order = np.argsort(-best)
        picked, src_count, dup_skipped = [], {}, 0
        for gi in order:
            gi = int(gi)
            key = (meta[gi]["page"], meta[gi]["chunk"])
            if key in seen_global:
                continue
            src = meta[gi]["source"]
            if src_count.get(src, 0) >= source_cap(src, args.per_source, args.per_source_local):
                continue
            grams = _char_grams(meta[gi]["text"])
            if _near_dup(grams, picked_grams):
                seen_global.add(key)   # a content-duplicate is spent, not deferred
                dup_skipped += 1
                continue
            seen_global.add(key)
            src_count[src] = src_count.get(src, 0) + 1
            picked_grams.append(grams)
            picked.append({"text": meta[gi]["text"], "source": src, "score": float(best[gi])})
            if len(picked) >= args.max_per_section:
                break
        if dup_skipped:
            log(f"section 〈{name}〉: skipped {dup_skipped} near-duplicate chunk(s) already placed elsewhere")
        md = "\n\n".join(
            f"［素材{i}］来源：{r['source']}（相关度{r['score']:.3f}）\n{r['text'].strip()}"
            for i, r in enumerate(picked, 1)
        )
        out.append({"name": name, "chunks": picked, "markdown": md, "count": len(picked)})
        log(f"section 〈{name}〉: {len(queries)} queries → {len(picked)} chunks")
    result = {"sections": out}
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False)
    else:
        print(json.dumps(result, ensure_ascii=False))


def cmd_retire(args):
    """Permanently drop already-USED chunks from an index.

    A case that has been reasoned on or written up is SPENT: leaving it in the index
    lets a later section retrieve it again and repeat the same material. This removes
    those rows from embeddings.npy + meta.json in one atomic rewrite, so no subsequent
    retrieve-multi / query can surface them.

    Input JSON: a list of the used chunk TEXTS (or {"texts": [...]}). Matching is by
    whitespace-normalized text AND by n-gram containment (`_near_dup`), so the overlap
    -window twin and the reprint of the same passage retire together with it — which is
    the whole point: near-duplicates are exactly how the same case comes back.

    Retired records are appended to <index_dir>/retired.json (audit trail, never
    retrieved). Refuses to empty an index: if every remaining chunk would go, nothing
    is removed — a run with no material left would fabricate instead of repeat.
    """
    emb, meta = load_index(args.index)
    spec = json.load(open(args.texts_json, encoding="utf-8"))
    texts = spec.get("texts", []) if isinstance(spec, dict) else spec
    used_norm = {"".join(t.split()) for t in texts if t and t.strip()}
    used_grams = [_char_grams(t) for t in texts if t and t.strip()]
    if not used_norm:
        print(json.dumps({"removed": 0, "remaining": len(meta)}, ensure_ascii=False))
        return

    keep, drop = [], []
    for i, r in enumerate(meta):
        norm = "".join(r["text"].split())
        spent = norm in used_norm or _near_dup(_char_grams(r["text"]), used_grams)
        (drop if spent else keep).append(i)

    if not keep:
        log(f"retire: all {len(meta)} chunks matched — refusing to empty the index")
        print(json.dumps({"removed": 0, "remaining": len(meta)}, ensure_ascii=False))
        return
    if not drop:
        print(json.dumps({"removed": 0, "remaining": len(meta)}, ensure_ascii=False))
        return

    # Audit trail first: if the rewrite below fails, the record of what was spent survives.
    retired_path = os.path.join(args.index, "retired.json")
    try:
        with open(retired_path, encoding="utf-8") as f:
            retired = json.load(f)
    except Exception:
        retired = []
    retired.extend(meta[i] for i in drop)
    with open(retired_path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(retired, f, ensure_ascii=False)
    os.replace(retired_path + ".tmp", retired_path)

    # tmp + os.replace per file, same as cmd_index: a torn write would leave
    # embeddings/meta mismatched and load_index would (correctly) refuse the index.
    new_emb = emb[np.array(keep, dtype=int)]
    new_meta = [meta[i] for i in keep]
    emb_path = os.path.join(args.index, "embeddings.npy")
    np.save(emb_path + ".tmp.npy", new_emb)
    os.replace(emb_path + ".tmp.npy", emb_path)
    meta_path = os.path.join(args.index, "meta.json")
    with open(meta_path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(new_meta, f, ensure_ascii=False)
    os.replace(meta_path + ".tmp", meta_path)
    try:
        stats_path = os.path.join(args.index, "stats.json")
        with open(stats_path, encoding="utf-8") as f:
            stats = json.load(f)
        stats["chunks"] = len(new_meta)
        stats["retired"] = len(retired)
        with open(stats_path, "w", encoding="utf-8") as f:
            json.dump(stats, f, ensure_ascii=False, indent=2)
    except Exception:
        pass   # stats are informational; a missing/corrupt file must not fail the retire

    log(f"retire: dropped {len(drop)} spent chunk(s), {len(new_meta)} left")
    print(json.dumps({"removed": len(drop), "remaining": len(new_meta)}, ensure_ascii=False))


def cmd_query(args):
    emb, meta = load_index(args.index)
    recs = retrieve(emb, meta, args.query, args.topk, args.model,
                    per_source=args.per_source, per_source_local=args.per_source_local,
                    lambda_mult=args.mmr)
    if args.json:
        print(json.dumps(recs, ensure_ascii=False, indent=2))
    else:
        for i, r in enumerate(recs, 1):
            print(f"\n［{i}］来源：{r['source']}（相关度{r['score']:.3f}）\n{r['text']}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="sf.py kb")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("index")
    pi.add_argument("corpus")
    pi.add_argument("--index", required=True)
    pi.add_argument("--model", default=EMBED_MODEL)
    pi.add_argument("--chunk-tokens", type=int, default=400, dest="chunk_tokens")
    pi.add_argument("--overlap-tokens", type=int, default=80, dest="overlap_tokens")
    pi.add_argument("--min-chunk-tokens", type=int, default=30, dest="min_chunk_tokens")
    pi.add_argument("--min-prose", type=int, default=120, dest="min_prose",
                    help="drop chunks with < N chars of real prose (nav/link cruft); 0 disables")
    pi.add_argument("--batch", type=int, default=48)
    pi.add_argument("--append", action="store_true",
                    help="grow an existing index instead of overwriting (draft-time supplements)")
    pi.set_defaults(func=cmd_index)

    pm = sub.add_parser("retrieve-multi")
    pm.add_argument("index")
    pm.add_argument("--queries-json", required=True, dest="queries_json")
    pm.add_argument("--per-source", type=int, default=2, dest="per_source")
    pm.add_argument("--per-source-local", type=int, default=12, dest="per_source_local",
                    help="per-source cap for LOCAL material sources (non-http 来源, e.g. "
                         "参考资料/…) — one user-supplied file may carry many chunks")
    pm.add_argument("--max-per-section", type=int, default=20, dest="max_per_section")
    pm.add_argument("--model", default=EMBED_MODEL)
    pm.add_argument("--out", default="")
    pm.set_defaults(func=cmd_retrieve_multi)

    pr = sub.add_parser("retire")
    pr.add_argument("index")
    pr.add_argument("--texts-json", required=True, dest="texts_json",
                    help="JSON list (or {\"texts\":[…]}) of already-USED chunk texts to drop")
    pr.set_defaults(func=cmd_retire)

    pq = sub.add_parser("query")
    pq.add_argument("index")
    pq.add_argument("--query", required=True)
    pq.add_argument("--topk", type=int, default=8)
    pq.add_argument("--per-source", type=int, default=2, dest="per_source")
    pq.add_argument("--per-source-local", type=int, default=8, dest="per_source_local")
    pq.add_argument("--mmr", type=float, default=0.6)
    pq.add_argument("--model", default=EMBED_MODEL)
    pq.add_argument("--json", action="store_true")
    pq.set_defaults(func=cmd_query)

    args = ap.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
