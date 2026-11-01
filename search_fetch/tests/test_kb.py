#!/usr/bin/env python3
"""kb.py hybrid-retrieval logic tests — NO network, NO embedding endpoint, NO LLM.

Needs numpy only (kb.py imports it at module level): `python3 tests/test_kb.py`.
Covers the pure ranking/parsing layer that IMPLEMENTATION.md §5.4 relies on:
tokenizer (ASCII + CJK bigrams), Okapi BM25 exact-term ranking, RRF fusion,
date extraction (most recent wins), recency boost ordering, source-URL cleaning,
corpus page splitting, chunking, and the --append page-shift key invariant.
Embedding/retrieval paths that need the OpenRouter endpoint are NOT touched.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
# Offline: kb.py loads the cl100k tokenizer at import, and tiktoken DOWNLOADS it on a
# cache miss. Tests must never touch the network, so force kb's documented fallback
# token counter (the logic under test does not depend on exact token ids).
import types as _types  # noqa: E402

import numpy as np

_tt = _types.ModuleType("tiktoken")
def _offline_get_encoding(name):
    raise RuntimeError("tokenizer download disabled in tests")
_tt.get_encoding = _offline_get_encoding
sys.modules["tiktoken"] = _tt
from search_fetch import kb  # noqa: E402

_fail = 0


def check(name, cond):
    global _fail
    print(("  ✓ " if cond else "  ✗ ") + name)
    if not cond:
        _fail += 1


def run():
    # ── tokenizer: ASCII words + CJK character bigrams ──
    toks = kb.bm25_tokenize("欧盟货币政策 ECB rate 2026")
    check("tokenize CJK bigrams", "欧盟" in toks and "盟货" in toks and "政策" in toks)
    check("tokenize ascii words", "ecb" in toks and "rate" in toks and "2026" in toks)
    check("tokenize no unigram CJK", "欧" not in toks)

    # ── BM25: exact-term docs outrank unrelated docs ──
    docs = [
        "欧洲央行宣布加息，欧元汇率上涨。",
        "本地餐饮消费持续回暖，火锅门店排队。",
        "欧洲央行行长讲话，货币政策转向。",
    ]
    bm = kb.BM25([kb.bm25_tokenize(d) for d in docs])
    s = bm.scores(kb.bm25_tokenize("欧洲央行 货币政策"))
    check("bm25 relevant beats irrelevant", s[0] > s[1] and s[2] > s[1])
    check("bm25 both-terms doc ranks first", s[2] >= s[0])
    check("bm25 unknown term scores zero", not kb.BM25([["ab"]]).scores(["zz"]).any())

    # ── RRF fusion: item best on both lists wins; shape preserved ──
    dense = np.array([0.9, 0.5, 0.1])
    lex = np.array([10.0, 0.0, 20.0])
    fused = kb.rrf_fuse([dense, lex])
    check("rrf shape", fused.shape == (3,))
    check("rrf best-average-rank wins", int(np.argmax(fused)) == 0)
    # top-rank on one list (item2: lex #1, dense #3) beats mid-on-both (item1: #2/#3)
    check("rrf mixed ranks ordered", fused[2] > fused[1])

    # ── date extraction: most RECENT plausible date, multiple formats ──
    check("date CJK format", kb.extract_date("发布于2026年6月3日。") == "2026-06-03")
    check("date ISO format", kb.extract_date("updated 2025-12-31") == "2025-12-31")
    check(
        "date most recent wins",
        kb.extract_date("首发2024年1月1日，更新2026年2月10日") == "2026-02-10",
    )
    check("date none -> empty", kb.extract_date("没有日期的文本") == "")
    check("date rejects month 13", kb.extract_date("2026-13-01") == "")

    # ── page-level publication date (fetch-injected （发布时间：…） header) ──
    check("page pub date read", kb.page_pub_date("（发布时间：2026-07-02）\n\n正文…") == "2026-07-02")
    check("page pub date absent", kb.page_pub_date("正文没有头。") == "")
    check("page pub date only in head", kb.page_pub_date("x" * 300 + "（发布时间：2026-07-02）") == "")
    # chunk date: the page header BEATS an in-prose event date (publication ≠ event)
    dated_body = "（发布时间：2026-07-02）\n\n" + ("回顾2019年5月1日的事件。" + "内容" * 80 + "\n\n") * 2
    recs, _ = kb.build_chunks("##### 来源：https://a.com/1\n" + dated_body, 200, 20, 8, min_prose=0)
    check("page date beats prose date", bool(recs) and all(r["date"] == "2026-07-02" for r in recs))
    # no header → per-chunk extract_date still applies
    recs2, _ = kb.build_chunks("##### 来源：https://a.com/2\n回顾2019年5月1日的事件。" + "内容" * 80,
                               200, 20, 8, min_prose=0)
    check("no header falls back to prose date", bool(recs2) and recs2[0]["date"] == "2019-05-01")

    # ── recency boost: newer chunk gets a strictly larger multiplier ──
    check("recency undated is 1.0", kb.recency_boost("") == 1.0)
    old, new = kb.recency_boost("2020-01-01"), kb.recency_boost("2026-06-01")
    check("recency newer > older", new > old >= 1.0)
    check("recency bounded by 1+w", new <= 1.0 + kb.RECENCY_WEIGHT + 1e-9)

    # ── source-URL cleaning: engine redirects decoded, tracking stripped ──
    import base64

    real = "https://example.com/article?id=7"
    b64 = base64.urlsafe_b64encode(real.encode()).decode().rstrip("=")
    check(
        "bing /ck/a redirect decoded",
        kb.clean_source_url(f"https://www.bing.com/ck/a?u=a1{b64}&extra=x")
        == real,
    )
    check(
        "ddg uddg decoded",
        kb.clean_source_url(
            "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fp%3Fid%3D7"
        )
        == "https://example.com/p?id=7",
    )
    check(
        "utm stripped, real params kept",
        kb.clean_source_url("https://a.com/x?utm_source=tw&id=5")
        == "https://a.com/x?id=5",
    )

    # ── corpus page split on 来源 markers ──
    corpus = (
        "preamble noise\n\n##### 来源：https://a.com/1\n正文甲。\n\n"
        "##### 来源：https://b.com/2\n正文乙。\n"
    )
    pages = kb.split_pages(corpus)
    check("split two pages", len(pages) == 2)
    check("split drops preamble", pages[0][1] == "正文甲。")
    check("split keeps urls", pages[0][0] == "https://a.com/1" and pages[1][0] == "https://b.com/2")
    check("split no markers -> whole corpus", kb.split_pages("无标记文本")[0][0] == "(unknown)")

    # ── chunking: paragraphs pack, long text splits, nothing lost ──
    body = "\n\n".join(f"第{i}段。" + "内容" * 30 for i in range(10))
    chunks = kb.chunk_page(body, chunk_tokens=120, overlap_tokens=20)
    check("chunking splits long page", len(chunks) > 1)
    check("chunking keeps all paragraphs", all(f"第{i}段" in "".join(chunks) for i in range(10)))

    # ── boilerplate filter: nav link lists dropped, prose kept ──
    nav = "\n".join(f"- [link {i}](https://x.com/{i})" for i in range(20))
    prose = "这是一段真正的正文内容。" * 20
    check("boilerplate nav dropped", kb.is_boilerplate(nav, min_prose=120))
    check("boilerplate prose kept", not kb.is_boilerplate(prose, min_prose=120))

    # ── --append page-shift invariant: (page, chunk) keys stay unique ──
    # (exercises the REAL kb.append_page_base, the same function cmd_index --append calls)
    old_meta = [{"page": 0, "chunk": 0}, {"page": 2, "chunk": 1}]
    new_records = [{"page": 0, "chunk": 0}, {"page": 1, "chunk": 0}]
    page_base = kb.append_page_base(old_meta)
    for r in new_records:
        r["page"] = r.get("page", 0) + page_base
    keys = {(r["page"], r["chunk"]) for r in old_meta + new_records}
    check("append keys unique", len(keys) == len(old_meta) + len(new_records))
    check("append base after max old page", page_base == 3)
    check("append base of empty index", kb.append_page_base([]) == 1)

    # ── --append stats merge: totals accumulate, batch numbers never overwrite ──
    old_stats = {"pages": 7, "usage": {"prompt_tokens": 100, "total_tokens": 120,
                                       "requests": 2, "cost": 0.5}}
    npages, usage = kb.merge_stats(old_stats, 3, {"prompt_tokens": 10, "total_tokens": 12,
                                                  "requests": 1, "cost": 0.25})
    check("stats pages accumulate", npages == 10)
    check("stats tokens sum", usage["prompt_tokens"] == 110 and usage["total_tokens"] == 132)
    check("stats requests sum", usage["requests"] == 3)
    check("stats cost sums as float", abs(usage["cost"] - 0.75) < 1e-9)
    npages, usage = kb.merge_stats({}, 3, {"prompt_tokens": 10, "cost": 0.25})
    check("stats tolerate missing old keys", npages == 3 and usage["prompt_tokens"] == 10
          and usage["cost"] == 0.25)
    npages, usage = kb.merge_stats({"pages": None, "usage": None}, 2, {"cost": 0.1})
    check("stats tolerate null old values", npages == 2 and abs(usage["cost"] - 0.1) < 1e-9)

    # source_cap: local material sources (non-http 来源, e.g. 参考资料/…) get the
    # WIDER per-source cap so one user-supplied transcript can dominate a section.
    check("cap http source tight", kb.source_cap("https://a.com/x", 2, 12) == 2)
    check("cap local material wide", kb.source_cap("参考资料/访谈.txt", 2, 12) == 12)
    check("cap web_search补充 wide", kb.source_cap("web_search补充", 2, 12) == 12)
    check("cap unknown page wide", kb.source_cap("(unknown)", 2, 12) == 12)

    # ── retire: a used case leaves the index for good, with its near-dup twins ──
    import argparse
    import tempfile

    def _mk_index(d, texts):
        os.makedirs(d, exist_ok=True)
        np.save(os.path.join(d, "embeddings.npy"), np.eye(len(texts), 8))
        with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
            json.dump([{"page": i, "chunk": 0, "text": t, "source": "https://x"}
                       for i, t in enumerate(texts)], f, ensure_ascii=False)

    def _retire(d, used):
        used_path = os.path.join(d, "used.json")
        with open(used_path, "w", encoding="utf-8") as f:
            json.dump(used, f, ensure_ascii=False)
        kb.cmd_retire(argparse.Namespace(index=d, texts_json=used_path))
        with open(os.path.join(d, "meta.json"), encoding="utf-8") as f:
            return json.load(f), np.load(os.path.join(d, "embeddings.npy"))

    # A long CJK passage plus its overlap-window twin (a prefix of it), and unrelated
    # chunks. Retiring the passage must take the twin with it and spare the rest —
    # near-duplicates are exactly how the same case comes back in a later section.
    # (_near_dup exempts short chunks, so these are genuinely long and non-repetitive.)
    passage = (
        "美商务部工业与安全局六月十二日发布内部评估文件，要求各局在四十五天内报送先进模型对外扩散的"
        "风险清单，重点核查开源权重的下载来源、境外微调服务的算力归属，以及盟友企业在第三国的转授权"
        "安排；文件同时要求财政部与国家安全委员会就是否扩大实体清单提出会签意见，并在峰会前形成可对外"
        "宣示的口径，避免在谈判桌上被动。"
    )
    twin = passage[:int(len(passage) * 0.85)]
    other = (
        "欧盟委员会同期公布数字市场法执行进展报告，列举了守门人企业在应用商店计费、默认设置与数据互操作"
        "三方面的整改情况，并预告将对两家企业启动新一轮调查，相关听证安排在下一季度进行。"
    )
    third = (
        "日本经济产业省在年度白皮书中提出，将把半导体材料与精密设备的出口审查权限上收至本省直属机构，"
        "并对面向特定地区的成套设备交易实行逐案审批，理由是维护供应链的可预期性。"
    )
    with tempfile.TemporaryDirectory() as td:
        d = os.path.join(td, "index")
        _mk_index(d, [passage, twin, other, third])
        meta, emb = _retire(d, [passage])
        kept = [r["text"] for r in meta]
        check("retire drops the used chunk", passage not in kept)
        check("retire drops its near-duplicate twin", twin not in kept)
        check("retire spares unrelated material", other in kept and third in kept)
        check("retire keeps embeddings aligned", emb.shape[0] == len(meta))
        with open(os.path.join(d, "retired.json"), encoding="utf-8") as f:
            check("retire records what it spent", len(json.load(f)) == 2)
        # An empty used-list is a no-op, not an error.
        meta, _ = _retire(d, [])
        check("retire on empty input is a no-op", len(meta) == 2)
        # Retiring EVERYTHING left would leave the writer no material at all — refused,
        # because a run with nothing to cite fabricates instead of repeating.
        meta, _ = _retire(d, [other, third])
        check("retire refuses to empty the index", len(meta) == 2)

    print()
    if _fail:
        print(f"KB LOGIC: FAIL ({_fail})")
        sys.exit(1)
    print("KB LOGIC: PASS ✓")


if __name__ == "__main__":
    run()
