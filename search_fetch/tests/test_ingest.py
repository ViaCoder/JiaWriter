#!/usr/bin/env python3
"""Materials-folder ingest tests — NO network, NO venv deps (stdlib only:
text/markdown parsing paths; PDF/OCR routing is checked WITHOUT importing pypdf).

Runnable anywhere: `python3 tests/test_ingest.py`. Scratch lives under
tests/tmp (inside the repo, per the confinement rule).
"""
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "src"))
TMP = os.path.join(HERE, "tmp", "ingest")

from pathlib import Path  # noqa: E402

from search_fetch import docparse, ingest  # noqa: E402

_fail = 0


def check(name, cond):
    global _fail
    print(("  ✓ " if cond else "  ✗ ") + name)
    if not cond:
        _fail += 1


def symlink_confinement():
    """Symlinks in 参考资料/: followed only while the target's real path stays inside
    the folder; links to outside files/dirs (or dangling / looping) are reported
    `outside_root` and NEVER read."""
    base = os.path.join(TMP, "links")
    shutil.rmtree(base, ignore_errors=True)
    outside = Path(base) / "outside"
    (outside / "dir").mkdir(parents=True)
    (outside / "secret.txt").write_text("OUTSIDE-SECRET-CANARY", encoding="utf-8")
    (outside / "dir" / "deep.txt").write_text("OUTSIDE-DIR-CANARY", encoding="utf-8")
    real_mat = Path(base) / "real-materials"
    (real_mat / "sub").mkdir(parents=True)
    (real_mat / "inside.txt").write_text("INSIDE-ORIGINAL 内部材料", encoding="utf-8")
    (real_mat / "sub" / "n.md").write_text("INSIDE-SUBDIR 子目录", encoding="utf-8")
    os.symlink(outside / "secret.txt", real_mat / "leak.txt")              # file → outside
    os.symlink(outside / "dir", real_mat / "leakdir")                       # dir → outside
    os.symlink("../outside/secret.txt", real_mat / "rel-leak.txt")         # relative escape
    os.symlink(real_mat / "inside.txt", real_mat / "alias.txt")             # file → inside
    os.symlink(real_mat / "sub", real_mat / "sub-alias")                    # dir → inside
    os.symlink(real_mat, real_mat / "sub" / "loop")                         # dir loop → root
    os.symlink(real_mat / "missing.txt", real_mat / "dangling.txt")         # dangling
    # The configured root ITSELF may be a symlink to the real folder (allowed).
    root = Path(base) / "参考资料"
    os.symlink(real_mat, root)

    cwd = os.getcwd()
    workdir = os.path.join(base, "work")
    os.makedirs(workdir)
    os.chdir(workdir)
    try:
        rep = ingest.ingest_dir(root)
    finally:
        os.chdir(cwd)
    by = {f["file"]: f["status"] for f in rep["files"]}
    corpus = rep["corpus"]
    check("symlink file → outside: refused", by.get("leak.txt") == "outside_root")
    check("relative ../ symlink escape: refused", by.get("rel-leak.txt") == "outside_root")
    check("symlink dir → outside: refused, not traversed",
          by.get("leakdir") == "outside_root" and not any(k.startswith("leakdir/") for k in by))
    check("dangling symlink reported, no crash", by.get("dangling.txt") == "outside_root")
    check("no outside content in corpus",
          "OUTSIDE-SECRET-CANARY" not in corpus and "OUTSIDE-DIR-CANARY" not in corpus)
    res = Path(workdir) / ".search_fetchres"
    leaked = [p.name for p in res.glob("*") if "CANARY" in p.read_text(encoding="utf-8", errors="ignore")] \
        if res.is_dir() else []
    check("no outside content in saved artifacts", leaked == [])
    check("regular files still ingested", by.get("inside.txt") == "ok" and by.get("sub/n.md") == "ok")
    check("symlink file → inside: ingested", by.get("alias.txt") == "ok")
    check("symlink dir → inside: allowed, no duplicate of the real folder",
          "sub-alias" not in by and sum(1 for k in by if k.endswith("n.md")) == 1)
    check("symlink loop terminates (root walked once)",
          sum(1 for k in by if k.endswith("inside.txt")) == 1)
    check("root given as a symlink still works", "INSIDE-ORIGINAL" in corpus)


def run():
    # ── decode: utf-8 (BOM) first, GBK second ─────────────────────────
    check("utf-8 decode", docparse._decode_text("温州调研".encode()) == "温州调研")
    check("utf-8 BOM stripped", docparse._decode_text("温州".encode("utf-8-sig")) == "温州")
    check("gbk decode", docparse._decode_text("温州拆迁".encode("gbk")) == "温州拆迁")

    # ── local kind routing (extension + %PDF magic; no third-party import) ──
    check("txt → text", ingest._local_kind(Path("a.txt"), b"x") == "text")
    check("md → text", ingest._local_kind(Path("a.md"), b"x") == "text")
    check(".pdf ext → pdf", ingest._local_kind(Path("a.pdf"), b"x") == "pdf")
    check("%PDF magic wins for unknown ext", ingest._local_kind(Path("a.dat"), b"%PDF-1.7") == "pdf")
    check("docx → docx", ingest._local_kind(Path("a.docx"), b"PK") == "docx")
    check("png → image", ingest._local_kind(Path("a.png"), b"\x89PNG") == "image")
    check("mp3 unsupported", ingest._local_kind(Path("a.mp3"), b"ID3") == "")

    # ── ingest_dir end-to-end (text-only; artifacts land in cwd/.search_fetchres) ──
    shutil.rmtree(TMP, ignore_errors=True)
    mats = os.path.join(TMP, "参考资料")
    os.makedirs(os.path.join(mats, "子目录"))
    with open(os.path.join(mats, "访谈.txt"), "w", encoding="utf-8") as f:
        f.write("全市完成政策处理面积120万平方米。")
    with open(os.path.join(mats, "子目录", "笔记.md"), "wb") as f:
        f.write("温州安置房舆情".encode("gbk"))
    with open(os.path.join(mats, ".隐藏.txt"), "w") as f:
        f.write("must not appear")
    with open(os.path.join(mats, "录音.mp3"), "wb") as f:
        f.write(b"ID3")
    with open(os.path.join(mats, "空文件.txt"), "w") as f:
        f.write("   ")

    with open(os.path.join(mats, "超大.pdf"), "wb") as f:
        f.write(b"%PDF-" + b"0" * 4096)

    old_cwd = os.getcwd()
    workdir = os.path.join(TMP, "work")
    os.makedirs(workdir)
    os.chdir(workdir)
    real_cap = docparse.DOC_MAX_BYTES
    docparse.DOC_MAX_BYTES = 1024   # make 超大.pdf exceed the cap without a real 40MB file
    try:
        rep = ingest.ingest_dir(Path(mats))
    finally:
        docparse.DOC_MAX_BYTES = real_cap
        os.chdir(old_cwd)

    by = {f["file"]: f for f in rep["files"]}
    check("two text files ok", by.get("访谈.txt", {}).get("status") == "ok"
          and by.get("子目录/笔记.md", {}).get("status") == "ok")
    check("hidden file skipped", not any("隐藏" in f["file"] for f in rep["files"]))
    check("mp3 unsupported", by.get("录音.mp3", {}).get("status") == "unsupported")
    check("blank file empty", by.get("空文件.txt", {}).get("status") == "empty")
    check("over-cap file skipped as too_large", by.get("超大.pdf", {}).get("status") == "too_large")
    check("corpus has per-file 来源 markers",
          "##### 来源：参考资料/访谈.txt" in rep["corpus"]
          and "##### 来源：参考资料/子目录/笔记.md" in rep["corpus"])
    check("gbk text decoded into corpus", "温州安置房舆情" in rep["corpus"])
    check("unsupported/hidden not in corpus", "must not appear" not in rep["corpus"]
          and "ID3" not in rep["corpus"])
    res_dir = os.path.join(workdir, ".search_fetchres")
    check("artifacts in cwd/.search_fetchres", os.path.isdir(res_dir)
          and any(n.endswith("_fit.md") for n in os.listdir(res_dir)))
    check("report is json-serializable", json.dumps(rep, ensure_ascii=False) != "")

    symlink_confinement()

    shutil.rmtree(TMP, ignore_errors=True)
    print("PASS" if _fail == 0 else f"FAIL ({_fail})")
    return 1 if _fail else 0


if __name__ == "__main__":
    sys.exit(run())
