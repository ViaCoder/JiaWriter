#!/usr/bin/env python3
"""Direct unit tests for the kb helpers: tracking-parameter cleanup, the embedding client
(HTTP mocked: success, rejected, retried, exhausted), batching, prose density, MMR, the
index loader, single and multi-query retrieval (deterministic fake embeddings), the
near-duplicate guard and the query command. Needs numpy (venv). No network.
Run: python3 tests/test_kb_units.py
"""
# Output capture.
import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

# numpy for the vectors.
import numpy as np

# Import the package from ./src.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from search_fetch import kb  # noqa: E402

# Scratch root inside the repository.
_TMP_ROOT = Path(__file__).resolve().parent / "tmp"
# Characters the fake embedding counts.
_VOCAB = "温州气候洪水概念验证中心政策资金企业"


def fake_embed(texts, model=None):
    """Deterministic embedding: character counts over a small vocabulary (+1 bias), not normalized."""
    # One row per text.
    vecs = np.array([[t.count(c) for c in _VOCAB] + [1] for t in texts], dtype=np.float32)
    # Shape and usage like the real client.
    return vecs, {"prompt_tokens": len(texts), "total_tokens": len(texts), "cost": 0.0}



class ApiKeyTest(unittest.TestCase):
    def test_api_key_prefers_openrouter_name(self):
        # The config.enc name wins; the old name still works; neither → empty.
        self.assertEqual(kb._api_key({"OPENROUTER_API_KEY": " a ", "OPENAI_API_KEY": "b"}), "a")
        self.assertEqual(kb._api_key({"OPENROUTER_API_KEY": "", "OPENAI_API_KEY": "b"}), "b")
        self.assertEqual(kb._api_key({}), "")

class Resp:
    """Minimal requests.Response stand-in."""

    def __init__(self, status, body):
        # Status and JSON body.
        self.status_code, self._body, self.text = status, body, json.dumps(body)

    def json(self):
        # Parsed body.
        return self._body


class KbUnitsTest(unittest.TestCase):
    def setUp(self):
        # Scratch directory.
        _TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.tmp = Path(tempfile.mkdtemp(prefix="kb-", dir=str(_TMP_ROOT)))

    def tearDown(self):
        # Remove it.
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_strip_tracking(self):
        # utm_*, fbclid and fragments go; real parameters stay.
        self.assertEqual(kb._strip_tracking("https://a.example/p?id=3&utm_source=x&fbclid=y#top"),
                         "https://a.example/p?id=3")

    def test_embed_batch_paths(self):
        # Success: rows sorted by index.
        body = {"data": [{"index": 1, "embedding": [0, 1]}, {"index": 0, "embedding": [1, 0]}], "usage": {"total_tokens": 4}}
        with mock.patch.object(kb, "API_KEY", "k"), mock.patch.object(kb.requests, "post", return_value=Resp(200, body)):
            vecs, usage = kb.embed_batch(["a", "b"])
        self.assertEqual((vecs.tolist(), usage), ([[1.0, 0.0], [0.0, 1.0]], {"total_tokens": 4}))
        # A 4xx is final after one request.
        with mock.patch.object(kb, "API_KEY", "k"), mock.patch.object(kb.requests, "post", return_value=Resp(401, {})) as post, \
                self.assertRaisesRegex(SystemExit, "rejected"):
            kb.embed_batch(["a"])
        self.assertEqual(post.call_count, 1)
        # A 500 is retried.
        with mock.patch.object(kb, "API_KEY", "k"), mock.patch.object(kb.time, "sleep"), \
                mock.patch.object(kb.requests, "post", side_effect=[Resp(500, {}), Resp(200, body)]):
            self.assertEqual(kb.embed_batch(["a", "b"])[0].shape, (2, 2))
        # Network errors exhaust the retries.
        with mock.patch.object(kb, "API_KEY", "k"), mock.patch.object(kb.time, "sleep"), \
                mock.patch.object(kb.requests, "post", side_effect=OSError("down")), \
                self.assertRaisesRegex(SystemExit, "after 2 tries: down"):
            kb.embed_batch(["a"], max_retries=2)
        # No key at all.
        with mock.patch.object(kb, "API_KEY", ""), self.assertRaises(SystemExit):
            kb.embed_batch(["a"])

    def test_embed_all_batches_and_empty(self):
        # Three texts in batches of two: two requests, stacked rows, summed usage.
        with mock.patch.object(kb, "embed_batch", side_effect=fake_embed), contextlib.redirect_stderr(io.StringIO()):
            vecs, total = kb.embed_all(["温州", "洪水", "资金"], batch=2)
        self.assertEqual((vecs.shape[0], total["requests"], total["prompt_tokens"]), (3, 2, 3))
        self.assertEqual(kb.embed_all([])[0].shape, (0, 1024))

    def test_prose_density_and_ratio(self):
        # Link labels kept, URLs and markers dropped; ratio of matching lines.
        self.assertEqual(kb.prose_density("- [温州新闻](https://x.example/a) https://y.example\n## 标题"), len("温州新闻 \n标题"))
        import re
        self.assertEqual((kb._ratio(["a1", "b", "c2", "d"], re.compile(r"\d")), kb._ratio([], re.compile("x"))), (0.5, 0.0))

    def test_mmr(self):
        # The best match first, then the diverse one over the near-copy.
        q = np.array([1.0, 0.0])
        cands = kb.normalize(np.array([[1.0, 0.0], [0.99, 0.01], [0.6, 0.8]], dtype=np.float32))
        # λ=0.3: the near-copy scores 0.3·1 − 0.7·1 = −0.4, the diverse one 0.18 − 0.42 = −0.24.
        self.assertEqual(kb.mmr(q, cands, k=2, lambda_mult=0.3), [0, 2])
        self.assertEqual(kb.mmr(q, np.zeros((0, 2)), k=3), [])

    def _index(self, texts):
        # An index dir with embeddings and meta.
        d = self.tmp / "idx"
        d.mkdir(exist_ok=True)
        np.save(d / "embeddings.npy", kb.normalize(fake_embed(texts)[0]))
        meta = [{"text": t, "source": f"https://s{i % 2}.example/", "page": i, "chunk": 0, "date": ""} for i, t in enumerate(texts)]
        (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        return d

    def test_load_index_ok_missing_and_torn(self):
        # A good index loads; a missing one and a torn one exit with a message.
        d = self._index(["温州洪水", "概念验证中心"])
        emb, meta = kb.load_index(str(d))
        self.assertEqual((emb.shape[0], len(meta)), (2, 2))
        with self.assertRaisesRegex(SystemExit, "not found"):
            kb.load_index(str(self.tmp / "none"))
        (d / "meta.json").write_text("[]", encoding="utf-8")
        with self.assertRaisesRegex(SystemExit, "corrupt"):
            kb.load_index(str(d))

    def test_retrieve_ranks_and_caps_per_source(self):
        # The flood texts rank first; at most one chunk per source.
        texts = ["温州洪水洪水", "温州洪水", "概念验证中心资金", "企业政策"]
        d = self._index(texts)
        emb, meta = kb.load_index(str(d))
        with mock.patch.object(kb, "embed_batch", side_effect=fake_embed):
            recs = kb.retrieve(emb, meta, "洪水", topk=2, model="m", per_source=1, per_source_local=1)
        self.assertIn("洪水", recs[0]["text"])
        self.assertEqual(len({r["source"] for r in recs}), len(recs))

    def test_char_grams_and_near_dup(self):
        # A reprint inside a longer chunk is a near-duplicate; short chunks are exempt.
        long_text = ("温州市人工智能概念验证中心自去年启动建设以来，先后引进高校院所十二家，"
                     "完成项目验证三十七项，带动企业新增研发投入近两亿元，部分成果已在本地制造业落地应用。")
        g = kb._char_grams(long_text)
        self.assertEqual(kb._char_grams("abcd"), frozenset({"abc", "bcd"}))
        self.assertTrue(kb._near_dup(g, [kb._char_grams(long_text + "另有补充说明。")]))
        self.assertFalse(kb._near_dup(kb._char_grams("短句"), [kb._char_grams("短句")]))

    def test_cmd_retrieve_multi_exclusive_sections(self):
        # Two sections asking for the same material never get the same chunk.
        d = self._index(["温州洪水应对", "概念验证中心资金", "企业政策支持", "气候变化温州"])
        spec = self.tmp / "q.json"
        spec.write_text(json.dumps({"sections": [{"name": "一", "queries": ["洪水", "温州"]},
                                                 {"name": "二", "queries": ["洪水"]}]}, ensure_ascii=False), encoding="utf-8")
        out = self.tmp / "out.json"
        args = SimpleNamespace(index=str(d), queries_json=str(spec), model="m", per_source=5, per_source_local=5,
                               max_per_section=2, out=str(out))
        with mock.patch.object(kb, "embed_batch", side_effect=fake_embed), contextlib.redirect_stderr(io.StringIO()):
            kb.cmd_retrieve_multi(args)
        secs = json.loads(out.read_text(encoding="utf-8"))["sections"]
        texts = [c["text"] for s in secs for c in s["chunks"]]
        self.assertEqual(len(texts), len(set(texts)))
        self.assertTrue(secs[0]["markdown"].startswith("［素材1］来源："))

    def test_cmd_query_text_and_json(self):
        # Numbered text output and a JSON list.
        d = self._index(["温州洪水", "企业政策"])
        args = SimpleNamespace(index=str(d), query="洪水", topk=1, model="m", per_source=2, per_source_local=2, mmr=0.6, json=False)
        with mock.patch.object(kb, "embed_batch", side_effect=fake_embed), contextlib.redirect_stdout(io.StringIO()) as out:
            kb.cmd_query(args)
        self.assertIn("［1］来源：", out.getvalue())
        args.json = True
        with mock.patch.object(kb, "embed_batch", side_effect=fake_embed), contextlib.redirect_stdout(io.StringIO()) as out:
            kb.cmd_query(args)
        self.assertEqual(len(json.loads(out.getvalue())), 1)


if __name__ == "__main__":
    # Run with the conventional summary line for run_all.sh.
    result = unittest.main(exit=False, verbosity=1).result
    print("\nKB UNITS:", "PASS ✓" if result.wasSuccessful() else "FAILED ✗")
    sys.exit(0 if result.wasSuccessful() else 1)
