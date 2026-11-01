#!/usr/bin/env python3
"""Function → test map of search_fetch (stdlib only).

Lists every module-level function and class method under src/search_fetch and the tests
that reference it directly (by name, attribute or string), as `test_file::test_function:line`.
Exits 1 when any function has no test, so `tests/run_all.sh` fails on an untested function.
Run: python3 tests/function_map.py [--markdown]
"""
# AST parsing of sources and tests.
import ast

# Exit code and argv.
import sys

# Path arithmetic.
from pathlib import Path

# Repository root of search_fetch.
REPO = Path(__file__).resolve().parents[1]
# Package sources.
SRC = REPO / "src" / "search_fetch"
# Test files (scripts and unittest modules, eval included).
TESTS = REPO / "tests"
# Callbacks invoked by the framework, never by name (urllib handler hooks).
FRAMEWORK_HOOKS = {"http_open", "https_open"}


def functions(src: Path = SRC) -> list:
    """(module, qualified name) of every module-level function and class method."""
    # Collected names.
    out = []
    # Each module.
    for f in sorted(src.glob("*.py")):
        # Its syntax tree.
        tree = ast.parse(f.read_text(encoding="utf-8"))
        # Top-level statements.
        for node in tree.body:
            # A function.
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                out.append((f.stem, node.name))
            # A class: its methods.
            elif isinstance(node, ast.ClassDef):
                out += [(f.stem, f"{node.name}.{n.name}") for n in node.body
                        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    # All of them.
    return out


def _names_in(node) -> set:
    """Identifiers a node refers to: names, attributes and identifier-like string constants."""
    # Collected identifiers.
    out = set()
    # Walk the subtree.
    for n in ast.walk(node):
        # A bare name.
        if isinstance(n, ast.Name):
            out.add(n.id)
        # obj.attr.
        elif isinstance(n, ast.Attribute):
            out.add(n.attr)
        # mock.patch.object(module, "name").
        elif isinstance(n, ast.Constant) and isinstance(n.value, str) and n.value.isidentifier():
            out.add(n.value)
    # The identifiers.
    return out


def test_units(tests: Path = TESTS) -> dict:
    """'file::function:line' → identifiers it references, for every function in every test file
    (the line keeps same-named functions apart, e.g. a fake's run() and the suite's run())."""
    # Collected units.
    units = {}
    # Each test file (helpers such as calibrate.py and this file are not tests).
    for f in sorted(tests.rglob("*.py")):
        # Only test_*.py files.
        if not f.name.startswith("test_"):
            continue
        # Its syntax tree.
        tree = ast.parse(f.read_text(encoding="utf-8"))
        # Every function or method, nested included.
        for n in ast.walk(tree):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                units[f"{f.relative_to(tests).as_posix()}::{n.name}:{n.lineno}"] = _names_in(n)
    # The units.
    return units


def build_map(src: Path = SRC, tests: Path = TESTS) -> dict:
    """'module.function' → sorted list of test units that reference it."""
    # All test units.
    units = test_units(tests)
    # The map.
    out = {}
    # Each function.
    for mod, name in functions(src):
        # The bare name a test would use.
        short = name.split(".")[-1]
        # Framework hooks count as covered by their class's tests.
        if short in FRAMEWORK_HOOKS:
            short = name.split(".")[0]
        # Units that reference it.
        out[f"{mod}.{name}"] = sorted(u for u, ids in units.items() if short in ids)
    # The map.
    return out


def render(fmap: dict, markdown: bool = False) -> str:
    """The map as plain lines or a Markdown table."""
    # Markdown table.
    if markdown:
        rows = ["| Function | Tests |", "|---|---|"]
        rows += [f"| `{fn}` | {', '.join(f'`{t}`' for t in ts[:4]) or '**none**'}{' …' if len(ts) > 4 else ''} |"
                 for fn, ts in fmap.items()]
        return "\n".join(rows)
    # Plain lines.
    return "\n".join(f"{fn}: {', '.join(ts[:3]) or 'NONE'}{' …' if len(ts) > 3 else ''}" for fn, ts in fmap.items())


def main(argv=None) -> int:
    # Options.
    argv = sys.argv[1:] if argv is None else argv
    # The map.
    fmap = build_map()
    # Functions without a test.
    missing = [fn for fn, ts in fmap.items() if not ts]
    # Print it.
    print(render(fmap, markdown="--markdown" in argv))
    # Summary line.
    print(f"\nFUNCTION MAP: {len(fmap) - len(missing)}/{len(fmap)} functions tested"
          + (f" — untested: {', '.join(missing)}" if missing else " — PASS ✓"))
    # Fail when anything is untested.
    return 1 if missing else 0


if __name__ == "__main__":
    # Exit with the verdict.
    sys.exit(main())
