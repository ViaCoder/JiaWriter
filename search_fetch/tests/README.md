# search_fetch tests

All tests are **isolated** and **offline**: they never touch your real config, your Chrome
profile or a real website. Scratch files (temp `SEARCH_FETCH_HOME`, working folders for
`.search_fetchres/`) are created under `tests/tmp/` inside the repo and removed on exit.
`python3 -m unittest discover -s tests` (from this directory, with the venv python) runs every
suite, each through `tests/netguard.py`, which
refuses any socket connection that is not loopback — a test that reaches the internet
(an unmocked remote service, an engine, a CDN) fails on the spot.

| Script | Needs | What it covers |
|---|---|---|
| `test_pure.py` | stdlib | URL builders, slugs, the challenge heuristic, the observe page script's argument, the `SEARCH_FETCH_HOME` confinement default + override, the char clamp, the entry point's stale-name check, and an AST guard against module-shadowing parameters. |
| `test_kb.py` | numpy | KB sidecar pure logic: BM25/RRF fusion, date extraction, chunking, append-index invariants. |
| `test_docparse.py` | stdlib | Document-fetch routing: extension/sniff gating, Content-Disposition, magic numbers + zip structure, in-page document links. |
| `test_media.py` | stdlib | Media ladder (URL classes, VTT cleaning, subtitle order, the deadline helper, metadata-only answer without subtitles) + the outbound policy of the media path. |
| `test_ingest.py` | stdlib | 参考资料 parsing: UTF-8/GBK fallback, type routing, 来源 markers, hidden/unsupported/empty filtering, symlink confinement. |
| `test_url_guard.py` | stdlib | Outbound-URL policy (SSRF / local-file guard): schemes, non-public addresses (literal/encoded/IPv4-mapped/DNS), per-redirect-hop re-check, the `--` argv contract. |
| `test_known_urls.py` | stdlib (+ numpy) | `SEARCH_FETCH_ONLY_KNOWN_URLS`: normalization, the run ledger fed by search results and KB sources, removal with the run directory. |
| `test_bridge.py` | stdlib | Chrome extension bridge: extension id from the manifest key, host-manifest locations (macOS/Linux), the installer (files, modes, manifest fields, launcher), framing, host routing, origin refusal, and the protocol end to end (real host + Unix socket, a thread playing the extension). |
| `test_pacing.py` | stdlib | Request pacing: host keys (loopback never paced), jitter, slot reservation, chained engine/host/nav gaps, and three processes queuing one gap apart. |
| `test_units.py` | venv (crawl4ai) | Engine helpers with fakes: I/O, `_act`, `_human_wait`, `_await_content`, markdown rendering, BM25, `cli.main()`. |
| `test_core_units.py` / `test_guard_media_units.py` / `test_docparse_units.py` / `test_kb_units.py` / `test_browser_search_units.py` | venv | Direct unit tests for every remaining function (see `function_map.py`). |
| `function_map.py` | stdlib | Function → test map; exits 1 while any function of `src/search_fetch` has no direct test. |
| `integration_chrome.py` | venv + Chrome for Testing | The bridge with a REAL browser on **local fixtures only**: the extension connects, a page renders to markdown with its date, a challenge page is blocked without hanging, SERP links are extracted, loopback is refused by default, `sf browser stop` closes the run's tabs. Skips when Chrome for Testing is missing (`SEARCH_FETCH_TEST_CHROME`). |
| `eval/run_eval.py` | venv + the bridge | Real-site evaluation set (20 queries, 30 URLs), human-paced. Not part of the offline suite; run it by hand only. |

Run with the venv python where third-party deps are needed:

```bash
PY=home/venv/bin/python3
python3 tests/netguard.py tests/test_pure.py     # any suite, outbound network blocked
$PY tests/netguard.py tests/test_units.py
$PY -m unittest discover -s tests                 # everything above, plus the function-map gate
$PY tests/function_map.py                        # every function has a direct test
$PY tests/integration_chrome.py                   # needs Chrome for Testing
```

`fixtures/` holds `article.html` (benign content page), `challenge.html` (a bot-challenge
marker page) and `searchpage.html` (a search form + results), served over a throwaway
127.0.0.1 HTTP server.
