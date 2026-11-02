# WriterAgent

English | [中文](README.zh.md)

WriterAgent is a general-purpose writing agent for the terminal. It reads reference material, searches the web, drafts and revises documents, checks drafts for AI-style writing, and exports Word documents. It is built on [pi](https://github.com/earendil-works/pi) v1.4.0 and released under the MIT license.

- Finished drafts are mainly Chinese, with English terms where needed, and use Chinese full-width punctuation throughout; the interface and tool output are Chinese by default and can switch to English.
- The writing is objective, neutral and clear; cited cases come only from the reference files or search results, with date and source in the text.
- Packages exist for Windows, macOS and Linux, each on amd64 and arm64.

## Install

1. Download the package for your platform: `writeragent-<platform>.tar.gz` (Linux, macOS) or `writeragent-<platform>.zip` (Windows), where the platform is `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`, `windows-x64` or `windows-arm64`. The packages and `SHA256SUMS` are attached to the runs of the "WriterAgent packages" GitHub Actions workflow.
2. Check the digests: `sha256sum -c SHA256SUMS` (on macOS `shasum -a 256 -c SHA256SUMS`).
3. Extract the package and run `writeragent` (`writeragent.exe` on Windows). Each package carries pinned fd and ripgrep, so nothing is downloaded at run time.
4. Load the package's `chrome-extension` folder in Chrome (once). Every package carries a Chinese `使用说明.html` that shows each step, from the model settings to the extension, with screenshots.

## Model configuration

The model is configured with environment variables. OpenAI Responses, OpenAI Chat Completions and Anthropic Messages are supported.

| Variable | Meaning | Default |
|---|---|---|
| `WA_URL` | API base URL | required |
| `WA_KEY` | API key | required |
| `WA_MODEL` | Model name | required |
| `WA_API` | API type: `anthropic-messages`, `openai-responses`, `openai-completions` | detected |
| `WA_CTX` | Context window (tokens) | 128000 |
| `WA_OUT` | Maximum output (tokens) | 128000 |
| `WA_REASONING` | Reasoning level: `off`, `low`, `medium`, `high`, `xhigh`, `max` | `medium` |
| `WA_LANG` | Interface and tool-output language: `zh`, `en` | `zh` |
| `WA_SEARCH` | Search backend: `auto`, `browser`, `anysearch`, `sf` | `auto` |
| `WA_ENGINES` | Engines the browser backend uses, in order | `bing,google` |
| `WA_SEARCH_PAGES` | Results pages per engine for the browser backend (3–5) | `3` |
| `WA_AUTO_EXPORT` | `off` stops the automatic docx export at the end of each run | on |
| `WA_SEARCH_KEY` | AnySearch key | anonymous when unset |
| `WA_SF` | Path of the search_fetch program | standard places |

Setting them (replace the example values):

- Linux, macOS (bash, zsh): `export WA_URL="https://api.example.com"`, `export WA_KEY="<your API key>"`, `export WA_MODEL="<model name>"`; add the lines to `~/.bashrc` or `~/.zshrc` to keep them.
- fish: `set -gx WA_URL https://api.example.com`, and the same for the others.
- Windows PowerShell: `$env:WA_URL="https://api.example.com"` for the current window; `setx WA_URL "https://api.example.com"` to keep it, then open a new terminal.
- Windows cmd: `set WA_URL=https://api.example.com`.

To detect the API type, WriterAgent sends one invalid request to each of three endpoints (an output limit of 0); servers reject it during validation, so nothing is generated and no tokens are used. The result is cached in `~/.writeragent/agent/api-detect.json` without the key. The key is read only from the environment and is written to no file.

Run `/wa` inside WriterAgent to see each variable's value in effect, where it comes from, and the setup commands for your platform.

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
| `/wa` | Read-only configuration page |
| `/lang zh`, `/lang en` | Interface language (`WA_LANG`, when set, takes precedence) |
| `/skills` | Manage writing skills: turn on or off, edit, update from this session, delete (after a backup) |
| `/skill-new` | New skill: from this session, from a blank template, or written by the model with skill-creator |
| `/browser` | Whether the Chrome extension is connected, and how to install it |
| `/import-doc [file]` | Import reference files |
| `/export-doc <draft.md> [md\|docx] [--profile=name] [--out=path]` | Export a draft |
| `/sf status`, `/sf install` | The same as `/browser` |

## Reference material

Put reference files in `参考资料/` (or `sources/`) in the writing folder. At startup and before every prompt WriterAgent imports new and changed files automatically into Markdown with page markers under `参考资料/.parsed/`, where `read` and `grep` find them, so citations can name a page. Imported text is treated as untrusted data, and instructions in it are not followed.

WriterAgent does no OCR: a scan without a text layer is listed in the import report and not imported; use a PDF or Word file with a text layer instead. Nothing you import leaves your computer.

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

Latin text and digits use Times New Roman, line spacing is exactly 32 pt, the page is A4 with GB/T 9704-2012 margins (37, 35, 28 and 26 mm), and the footer carries centred page numbers. Fonts are referenced by name with no fallback; install and license them on your own computer. A custom profile is a JSON file with only the fields to change, for example `{"lineSpacingPt": 28}`, given with `--profile=file.json` or saved as `~/.writeragent/agent/profiles/<name>.json` and given by name.

After writing the docx, the export checks its XML: every run with Chinese text carries `w:hint="eastAsia"` and a Chinese font; it counts ASCII punctuation next to Chinese characters and unpaired quotes, lists the sizes and line spacing in use, and reports any 待核实 mark left in the draft.

## Writing skills

Nine built-in skills ship in Chinese and English and follow the interface language: general article, report and analysis, news and features, academic writing, business email and memos, marketing copy, narrative fiction, skill-creator, and the Chinese official-document skill [lieflat-gongwen](https://github.com/larashero3-dotcom/lieflat-gongwen). lieflat-gongwen covers 调研报告, 领导讲话, 工作意见, 经验材料, 工作方案, 经验总结 and short 党建 pieces with parameters from a corpus of official documents, and checks drafts with the `gongwen_check` tool; its material is Chinese only, so the English entry reads the Chinese folder. Your own skills go in `~/.writeragent/agent/skills/<name>/SKILL.md` and take the place of a built-in skill with the same name.

A skill made from a session collects only what you wrote in the current session and the reasons you gave for refused tool calls, never model replies; keys, tokens and passwords are removed first, and for a repeated topic the latest request is kept. You review the draft before anything is written.

## Search

- `auto` (default): the browser when the Chrome extension is connected, else AnySearch, with a note at the top of the results.
- `browser`: your own Chrome, on all six platforms. The writeragent program itself is the extension's native messaging host; a release build registers it with Chrome at startup (Chrome's NativeMessagingHosts folder on Linux and macOS, the current user's registry on Windows), with no Python or other dependency.
  - Searching works as a person does: open Bing's home page, click the search box, type the query key by key, press Enter, scroll through the results and click "Next"; after 3–5 pages the same on Google. A cookie consent dialog is accepted with a click. Clicks, typing and scrolling go through `chrome.debugger`'s Input domain, so pages receive the same trusted events (isTrusted) as from a real mouse and keyboard. Only the time filter (`fresh`) adds the engine's filter parameter to the results address, because its menu is several clicks deep.
  - The results of both engines are merged and ranked on this computer: BM25 of the query against title and snippet (0.45), reciprocal-rank fusion of the positions on both engines (0.35), and the share of query terms covered (0.20).
  - A result still shown on an open results page is clicked there and the tab goes back afterwards; other addresses open in a new tab. The page is scrolled a few times, then Readability (Firefox's reader-view algorithm) takes the main text; PDF and Word documents are downloaded through Chrome and parsed here.
  - Two queries to the same engine are at least 20 seconds apart, two visits to the same site at least 6 seconds, both with random jitter; local and private network addresses are refused. On a human check, interactive mode brings the Chrome window to the front and waits up to 90 seconds for you.
  - Before the first use, load the extension: open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and choose the package's `chrome-extension` folder. Check with `/browser`.
- `anysearch`: the AnySearch API, anonymously when no key is set.
- `sf`: search_fetch, whose pages go through the same extension. It reads the text layer of documents and the metadata and subtitles of videos; it does no OCR and no speech recognition. All six packages include sf (`sf.exe` on Windows, where it reaches the browser host through its loopback port and token). The Windows on Arm package carries the x64 sf, which Windows 11 runs through its x64 emulation, because two of sf's dependencies (lxml 5.x for crawl4ai, and tiktoken) have no Windows Arm build. The first sf run installs its dependencies (about 1.1 GB, a few minutes), all under `~/.writeragent/agent/sf/`.

## Network and privacy

WriterAgent sends no network request at startup or while idle, and has no telemetry, version check or upload. It goes online only for your configured model API, the search backend, and URLs you ask it to import; OCR of scans sends page images to a public Hugging Face Space. All configuration and sessions live under `~/.writeragent/`; a release build also writes a small native messaging host manifest for Chrome at startup (see Search).

## Platforms and testing

On every push to dev, GitHub Actions runs WriterAgent's own tests on all six platforms, builds the six packages, and checks each package on its own platform: fd and ripgrep run, the extension, the guide and the reference folder are in the package, `--version`, `--help`, one writing run against a local mock model server, one round of PDF import, docx export and automatic export, and the extension's native messaging host (a request routed through the program to a fake extension and back, a stranger refused; no key, no real model). On every platform it also runs the bundled sf; on Windows it also runs the guide's `setx`, and on Linux and macOS it checks the interactive interface in both languages. The full upstream pi test suite runs on Linux. The browser backend is tested on the development machine in Chrome for Testing against local look-alike Bing and Google pages (every event the pages receive is trusted).

The development machine is Linux x64, where the Linux setup commands were run; the Windows `setx` runs on CI's Windows machines; the macOS commands follow zsh's syntax, and the Windows cmd form has not been run.

## License

MIT, see [LICENSE](LICENSE), with pi's original copyright notice kept. The `THIRD_PARTY/` folder of each package holds the licenses of fd, ripgrep, unpdf (with pdf.js and its decoders), docx, fflate, Readability, the Unicode data and lieflat-gongwen.

Exception: `skills/writer/*/lieflat-gongwen/`, `src/writer/gongwen/` and `src/extensions/writer-gongwen/` are under the [PolyForm Noncommercial License 1.0.0](packages/coding-agent/skills/writer/zh/lieflat-gongwen/LICENSE), for noncommercial use only. Remove these three before commercial use, or get a license from the original author.
