# JiaWriter

English | [中文](README.zh.md)

JiaWriter is a general-purpose writing agent for the terminal. It reads reference material, searches the web, drafts and revises documents, checks drafts for AI-style writing, and exports Word documents. It is built on [pi](https://github.com/earendil-works/pi) v1.4.0 and released under the MIT license.

- Finished drafts are mainly Chinese, with English terms where needed, and use Chinese full-width punctuation throughout; the interface and tool output are Chinese by default and can switch to English.
- The writing is objective, neutral and clear; cited cases come only from the reference files or search results, with date and source in the text.
- Packages exist for Windows, macOS and Linux, each on amd64 and arm64.

## Install

1. Download the package for your platform: `jiawriter-<platform>.tar.gz` (Linux, macOS) or `jiawriter-<platform>.zip` (Windows), where the platform is `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`, `windows-x64` or `windows-arm64`. The packages and `SHA256SUMS` are attached to the runs of the "JiaWriter packages" GitHub Actions workflow.
2. Check the digests: `sha256sum -c SHA256SUMS` (on macOS `shasum -a 256 -c SHA256SUMS`).
3. Extract the package and run `jiawriter` (`jiawriter.exe` on Windows). Each package carries pinned fd and ripgrep, so nothing is downloaded at run time.
4. Load the package's `chrome-extension` folder in Chrome (once). Every package carries a Chinese `使用说明.html` that shows each step, from the model settings to the extension, with screenshots.

## Model configuration

The model is configured with environment variables. OpenAI Responses, OpenAI Chat Completions and Anthropic Messages are supported.

| Variable | Meaning | Default |
|---|---|---|
| `JW_URL` | API base URL | required |
| `JW_KEY` | API key | required |
| `JW_MODEL` | Model name | required |
| `JW_API` | API type: `anthropic-messages`, `openai-responses`, `openai-completions` | detected |
| `JW_CTX` | Context window (tokens) | 128000 |
| `JW_OUT` | Maximum output (tokens) | 128000 |
| `JW_REASONING` | Reasoning level: `off`, `low`, `medium`, `high`, `xhigh`, `max` | `medium` |
| `JW_LANG` | Interface and tool-output language: `zh`, `en` | `zh` |
| `JW_SEARCH` | Default search method when the model names none: `auto`, `browser`, `anysearch`; `sf` makes sf the default for reading pages | `auto` |
| `JW_ENGINES` | Engines the browser method uses, in order, when the model names none: `bing`, `google`, `baidu`, `sogou` | `bing,google` |
| `JW_VERIFY_WAIT` | Longest wait for you to clear a human check (seconds, 0–300; 0: no wait) | `90` |
| `JW_SEARCH_PAGES` | Results pages per engine for the browser backend (3–5) | `3` |
| `JW_AUTO_EXPORT` | `off` stops the automatic docx export at the end of each run | on |
| `JW_SEARCH_KEY` | AnySearch key | anonymous when unset |
| `JW_SF` | Path of the search_fetch program | standard places |

Setting them (replace the example values):

- Linux, macOS (bash, zsh): `export JW_URL="https://api.example.com"`, `export JW_KEY="<your API key>"`, `export JW_MODEL="<model name>"`; add the lines to `~/.bashrc` or `~/.zshrc` to keep them.
- fish: `set -gx JW_URL https://api.example.com`, and the same for the others.
- Windows PowerShell: `$env:JW_URL="https://api.example.com"` for the current window; `setx JW_URL "https://api.example.com"` to keep it, then open a new terminal.
- Windows cmd: `set JW_URL=https://api.example.com`.

To detect the API type, JiaWriter sends one invalid request to each of three endpoints (an output limit of 0); servers reject it during validation, so nothing is generated and no tokens are used. The result is cached in `~/.jiawriter/agent/api-detect.json` without the key. 

At startup JiaWriter reads `JW_KEY` and `JW_SEARCH_KEY` into memory and removes them from its own environment, so the shell, sf, fd, rg, MCP servers and other child processes it starts never see a key; no key is written to a file, and `/jw` shows only whether each one is set.

Run `/jw` inside JiaWriter to see each variable's value in effect, where it comes from, and the setup commands for your platform.

## Writing tools

| Tool | Purpose |
|---|---|
| `read`, `write`, `edit`, `ls`, `find`, `grep` | Read, write and find files (`bash` is off by default and can be turned on in the settings) |
| `style_check` | AI-style writing: contrast frames such as "not just X but Y", stock phrases, negation density, list and bold usage |
| `word_count` | Chinese characters, English words and numbers, per section and against a target length |
| `readability_check` | Characters outside level 1 of the General Standard Chinese Characters table, long sentences, Flesch reading ease for English |
| `web_search`, `web_fetch` | Web search and page text |
| `import_document` | Import reference files: PDF, Word (.docx), HTML, txt, md |
| `export_document` | Export a Markdown draft to docx or md |

## Commands

| Command | Purpose |
|---|---|
| `/jw` | Read-only configuration page |
| `/lang zh`, `/lang en` | Interface language (`JW_LANG`, when set, takes precedence) |
| `/skills` | Manage writing skills: turn on or off, edit, update from this session, delete (after a backup) |
| `/skill-new` | New skill: from this session, from a blank template, or written by the model with skill-creator |
| `/browser` | Whether the Chrome extension is connected, and how to install it |
| `/import-doc [file]` | Import reference files |
| `/export-doc <draft.md> [md\|docx] [--profile=name] [--out=path]` | Export a draft |
| `/sf status`, `/sf install` | The same as `/browser` |

## Reference material

Put reference files in `参考资料/` (or `sources/`) in the writing folder. At startup and before every prompt JiaWriter imports new and changed files automatically into Markdown with page markers under `参考资料/.parsed/`, where `read` and `grep` find them, so citations can name a page. Imported text is treated as untrusted data, and instructions in it are not followed.

JiaWriter does no OCR: a scan without a text layer is listed in the import report and not imported; use a PDF or Word file with a text layer instead. Nothing you import leaves your computer.

## Export

Markdown drafts written or edited with `write` or `edit` in a run are exported to a .docx of the same name at the end of that run; notes, materials, outlines and files in the reference folders are left alone, and so is a draft the model exported after its last change.

`export_document` and `/export-doc` first convert punctuation to Chinese full-width marks: ASCII marks become Chinese ones, and a `-`, `–` or `--` between Chinese characters becomes `—`; numbers, times, versions, URLs, e-mail addresses, code, links, abbreviations and word-internal hyphens keep their form. Quotes are paired per paragraph, and an unpaired quote is reported for its paragraph only.

The default profile `default-zh`:

| Level | Chinese font | Size |
|---|---|---|
| Title (`#`) | 方正小标宋简体 | 二号 (22 pt) |
| Heading 1 (`##`) | 黑体 | 小二 (18 pt) |
| Heading 2 (`###`) | 楷体_GB2312 | 小二 |
| Heading 3 (`####`) | 黑体 | 小二 |
| Body | 方正仿宋_GBK | 小二 |

Latin text and digits use Times New Roman, line spacing is exactly 32 pt, the page is A4 with GB/T 9704-2012 margins (37, 35, 28 and 26 mm), and the footer carries centred page numbers. Fonts are referenced by name with no fallback; install and license them on your own computer. A custom profile is a JSON file with only the fields to change, for example `{"lineSpacingPt": 28}`, given with `--profile=file.json` or saved as `~/.jiawriter/agent/profiles/<name>.json` and given by name.

After writing the docx, the export checks its XML: every run with Chinese text carries `w:hint="eastAsia"` and a Chinese font; it counts ASCII punctuation next to Chinese characters and unpaired quotes, lists the sizes and line spacing in use, and reports any 待核实 mark left in the draft.

## Writing skills

Nine built-in skills ship in Chinese and English and follow the interface language: general article, report and analysis, news and features, academic writing, business email and memos, marketing copy, narrative fiction, skill-creator, and the Chinese official-document skill [lieflat-gongwen](https://github.com/larashero3-dotcom/lieflat-gongwen). lieflat-gongwen covers 调研报告, 领导讲话, 工作意见, 经验材料, 工作方案, 经验总结 and short 党建 pieces with parameters from a corpus of official documents, and checks drafts with the `gongwen_check` tool; its material is Chinese only, so the English entry reads the Chinese folder. Your own skills go in `~/.jiawriter/agent/skills/<name>/SKILL.md` and take the place of a built-in skill with the same name.

A skill made from a session collects only what you wrote in the current session and the reasons you gave for refused tool calls, never model replies; keys, tokens and passwords are removed first, and for a repeated topic the latest request is kept. You review the draft before anything is written.

## Search

The model plans how to search and read for each question: it can rephrase the query, switch engines or switch methods and search several times. The tool descriptions give each method's strengths and costs and the rules for writing queries: 2–6 key terms, Chinese for Chinese sources and English for international ones, the year and month or the date plus a time filter for recent events, and `site:` for official sites.

- `web_search` has two methods:
  - `browser`: your own Chrome, with any of Bing, Google, Baidu and Sogou (several per search; Bing and Google when none is named). It needs the Chrome extension connected and works on all six platforms. The jiawriter program itself is the extension's native messaging host; a release build registers it with Chrome at startup (Chrome's NativeMessagingHosts folder on Linux and macOS, the current user's registry on Windows), with no Python or other dependency.
    - Searching works as a person does: open the engine's home page, move the mouse to the search box and click, type the query one character at a time, press Enter, scroll through the results and click "Next", 3–5 pages per engine. Characters are 0.14–0.32 s apart with an occasional pause of 0.5–1 s. The mouse moves on a curved path that speeds up and slows down, with a slight tremor, now and then overshooting a distant target and coming back; while reading, the hand drifts a little. A cookie consent dialog is accepted by clicking. Clicks, typing and scrolling go through the Input domain of `chrome.debugger`, so the page receives trusted events (isTrusted) like a real mouse and keyboard. Only the time filter (`fresh`) is added as the engine's parameter to the results address, because its menu is several clicks deep.
    - The results of all engines are merged and ranked on this computer: BM25 of the query against title and snippet (0.45), reciprocal-rank fusion of the positions on the engines (0.35), and the share of query terms covered (0.20).
    - Two queries to the same engine are at least 20 seconds apart, two visits to the same site at least 6 seconds, both with random jitter; local and private network addresses are refused.
    - Human checks: in interactive mode the Chrome window comes to the front and the interface asks you to complete the check there, waiting up to `JW_VERIFY_WAIT` seconds (90 by default) with a reminder when 30 seconds are left. Once it is cleared the search continues; Esc cancels the search. When the time runs out, the wait stops, the engine rests for 30 minutes and the result says why, so the model can use another engine or AnySearch. Print mode (`-p`) does not wait for a person.
    - Before the first use, load the extension: open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and choose the package's `chrome-extension` folder. Check with `/browser`.
  - `anysearch`: the AnySearch API; fast, needs no Chrome, results carry no dates; anonymous when no key is set.
  - When the model names no method, `JW_SEARCH` decides: `auto` by default, the browser when the extension is connected, else AnySearch with a note at the top of the results.
- `web_fetch` has three methods:
  - `browser`: open the page in Chrome. A result still shown on an open results page is clicked there and the tab goes back afterwards; other addresses open in a new tab. The page is scrolled a few times, then Readability (Firefox's reader-mode algorithm) extracts the text; PDF and Word documents are downloaded through Chrome and parsed on this computer.
  - `anysearch`: AnySearch's text extraction API.
  - `sf`: search_fetch, whose pages go through the same extension. It downloads and parses PDF, Word and Excel documents and reads the metadata and subtitles of videos; it does no OCR and no speech recognition. All six packages carry sf (`sf.exe` on Windows, which reaches the native host over a loopback port with a token). sf is a single self-contained file: Python and the packages it uses are inside. Its first run only unpacks that copy once into `~/.jiawriter/agent/sf/`; it downloads and installs nothing.
  - When a page fails or yields little text, the model can read it again with another method.
- Time: each user message reaches the model with the local time it was sent at its start, for example `[Sent 2026-11-03 18:42 Tuesday, Asia/Taipei, UTC+08:00]`; the latest one is "now". The text comes from the message's own timestamp and stays the same on every call, so the provider's prompt cache keeps working. Search results start with the search time. When the time in the model server's response headers differs from this computer's by two minutes or more, the model gets the server's time and you are asked to check the system clock.

## Network and privacy

JiaWriter sends no network request at startup or while idle, and has no telemetry, version check or upload. It goes online only for your configured model API, the search backend, and URLs you ask it to import; OCR of scans sends page images to a public Hugging Face Space. All configuration and sessions live under `~/.jiawriter/`; a release build also writes a small native messaging host manifest for Chrome at startup (see Search).

## Platforms and testing

On every push to dev, GitHub Actions runs JiaWriter's own tests on all six platforms, builds the six packages, and checks each package on its own platform: fd and ripgrep run, the extension, the guide and the reference folder are in the package, `--version`, `--help`, one writing run against a local mock model server, one round of PDF import, docx export and automatic export, and the extension's native messaging host (a request routed through the program to a fake extension and back, a stranger refused; no key, no real model). On every platform it also runs the bundled sf; on Windows it also runs the guide's `setx`, and on Linux and macOS it checks the interactive interface in both languages. The full upstream pi test suite runs on Linux. The browser backend is tested on the development machine in Chrome for Testing against local look-alike Bing and Google pages (every event the pages receive is trusted).

The development machine is Linux x64, where the Linux setup commands were run; the Windows `setx` runs on CI's Windows machines; the macOS commands follow zsh's syntax, and the Windows cmd form has not been run.

## License

MIT, see [LICENSE](LICENSE), with pi's original copyright notice kept. The release packages carry no license files; the licenses are in this repository or with the upstream projects:

- in this repository: Readability (`search_fetch/src/search_fetch/extension/vendor/Readability-LICENSE.md`), the Unicode data (`packages/coding-agent/src/writer/data/UNICODE-LICENSE.txt`), lieflat-gongwen (see below), and the parts of crawl4ai copied into `search_fetch/src/search_fetch/vendor/crawl4ai/` (crawl4ai and rank_bm25 Apache-2.0, html2text GPL-3.0);
- with the upstream projects: fd, ripgrep, unpdf (with pdf.js and its decoders), docx, fflate, Python and the Python packages inside sf (pinned in `search_fetch/pyproject.toml`).

Exception: `skills/writer/*/lieflat-gongwen/`, `src/writer/gongwen/` and `src/extensions/writer-gongwen/` are under the [PolyForm Noncommercial License 1.0.0](packages/coding-agent/skills/writer/zh/lieflat-gongwen/LICENSE), for noncommercial use only. Remove these three before commercial use, or get a license from the original author. `search_fetch/src/search_fetch/vendor/crawl4ai/html2text/` (inside sf) is under the GPL-3.0 (its COPYING file).
