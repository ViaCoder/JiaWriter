# JiaWriter

English | [中文](README.zh.md)

JiaWriter is a general-purpose writing agent for the terminal. It reads reference material, searches the web, drafts and revises documents, checks drafts for AI-style writing, and exports Word documents. It is built on [pi](https://github.com/earendil-works/pi) v1.4.0 and released under the MIT license.

- Finished drafts are mainly Chinese, with English terms where needed, and use Chinese full-width punctuation throughout; the interface and tool output are Chinese by default and can switch to English.
- The writing is objective, neutral and clear; cited cases come only from the reference files or search results, with date and source in the text.
- Packages exist for Windows, macOS and Linux, each on amd64 and arm64.

## Install

1. Download the package for your platform: `jiawriter-<platform>.tar.xz` (Linux, macOS) or `jiawriter-<platform>.zip` (Windows), where the platform is `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`, `windows-x64` or `windows-arm64`. The packages and `SHA256SUMS` are attached to the runs of the "JiaWriter packages" GitHub Actions workflow.
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
| `JW_CTX` | Context window (tokens; 128k and 1m also work) | 128000 |
| `JW_OUT` | Maximum output (tokens; 128k and 1m also work) | 128000 |
| `JW_EFFORT` | Thinking intensity: `off`, `low`, `medium`, `high`, `xhigh`, `max`; the nearest level is used when the model lacks one | `medium` |
| `JW_LANG` | Interface and tool-output language: `zh`, `en` | `zh` |
| `JW_PERMISSION` | How much the browser and computer tools ask: `manual`, `auto` (default) or `bypass`. `/jw permission` saves a choice. | `auto` |
| `JW_BROWSER` | The `browser` tool: `on`, `off`, or unset to offer it when the Chrome extension is connected at session start. | follows the extension |
| `JW_IMAGE` | Whether the upstream takes images: `on`, `off`, or unset to find out when one is first needed. | found out once |
| `JW_IMAGE_MAX` | Images per message and per session, such as `1,10`. | `1,10` |
| `JW_IMAGE_EDGE` | Longest edge of a picture in pixels. | `1024` |
| `JW_COMPUTER` | `off` hides the `computer` tool. It appears at session start once `/jw computer` has installed the desktop driver. | follows the install |
| `JW_ENGINES` | Engines the browser method uses, in order, when the model names none: `bing`, `google`, `baidu`, `sogou` | `bing,google` |
| `JW_VERIFY_WAIT` | Longest wait for you to clear a human check (seconds, 0–300; 0: no wait) | `180` |
| `JW_SEARCH_PAGES` | Results pages per engine for the browser backend (3–5) | `3` |
| `JW_AUTO_EXPORT` | `off` stops the automatic docx export at the end of each run | on |
| `ANYSEARCH_KEY` | AnySearch key | anonymous when unset |
| `JW_SF` | Path of the search_fetch program | standard places |
| `PROMPT_ADD` | Text file added to the persona, for example `PROMPT_ADD='~/Downloads/glm.txt'`; its text follows the persona inside the same `<system_prompt>` tag | none |

Setting them (replace the example values):

- Linux, macOS (bash, zsh): `export JW_URL="https://api.example.com"`, `export JW_KEY="<your API key>"`, `export JW_MODEL="<model name>"`; add the lines to `~/.bashrc` or `~/.zshrc` to keep them.
- fish: `set -gx JW_URL https://api.example.com`, and the same for the others.
- Windows PowerShell: `$env:JW_URL="https://api.example.com"` for the current window; `setx JW_URL "https://api.example.com"` to keep it, then open a new terminal.
- Windows cmd: `set JW_URL=https://api.example.com`.

To detect the API type, JiaWriter sends one invalid request to each of three endpoints (an output limit of 0); servers reject it during validation, so nothing is generated and no tokens are used. The result is cached in `~/.jiawriter/agent/api-detect.json` without the key. 

At startup JiaWriter reads `JW_KEY` and `ANYSEARCH_KEY` into memory and removes them from its own environment, so the shell, sf, fd, rg, MCP servers and other child processes it starts never see a key; no key is written to a file, and `/jw` shows only whether each one is set.

Run `/jw` inside JiaWriter to see each variable's value in effect, where it comes from, and the setup commands for your platform.

## Writing tools

| Tool | Purpose |
|---|---|
| `read`, `write`, `edit`, `ls`, `find`, `grep` | Read, write and find files (`bash` is off by default and can be turned on in the settings) |
| `style_check` | AI-style writing: contrast frames such as "not just X but Y", stock phrases, negation density, list and bold usage |
| `word_count` | Chinese characters, English words and numbers, per section and against a target length |
| `readability_check` | Characters outside level 1 of the General Standard Chinese Characters table, long sentences, Flesch reading ease for English |
| `search_web`, `fetch_web` | Web search and page text |
| `import_document` | Import reference files: PDF, Word (.docx), HTML, txt, md |
| `export_document` | Export a Markdown draft to docx or md |
| `topic_open`, `material_add` | Open a topic folder; record cases and data with their sources |
| `draft_restore` | List a draft's saved versions and bring one back |

## Commands

| Command | Purpose |
|---|---|
| `/jw` | Read-only configuration page |
| `/effort [level]` | Change the thinking intensity; without a level, pick from a list (`/thinking` and Shift+Tab also work) |
| `/rewind` | Go back to before a message: conversation and files, conversation only, or files only |
| `/lang zh`, `/lang en` | Interface language (`JW_LANG`, when set, takes precedence) |
| `/skills` | Manage writing skills: turn on or off, edit, update from this session, delete (after a backup) |
| `/skill-new` | New skill: from this session, from a blank template, or written by the model with skill-creator |
| `/browser` | Whether the Chrome extension is connected, and how to install it |
| `/import-doc [file]` | Import reference files |
| `/export-doc <draft.md> [md\|docx] [--profile=name] [--out=path]` | Export a draft |
| `/sf status`, `/sf install` | The same as `/browser` |

## How writing works

Just talk to it; the model does the following by itself.

- **Topic folders**: when you start a writing topic, the model creates a folder of that name in the writing folder and reuses it later. It holds `稿件/` (Markdown and docx), `参考资料/`, `检索/` (each search), `网页/` (fetched pages in full, with URL, title and date) and `素材.md` (cases and data). Searches and pages are archived automatically; if no folder was opened they go to `未命名主题-<date>/`.
- **Research before drafting**: outline, ask which parts need cases or data, search and fetch for those parts one at a time, record materials, check for gaps, then write. The source of a material must be a page that was opened or a page of a reference file.
- **Paragraphs and sources**: in the parts that need them, a paragraph opens with a summary, then a case (time, reporter, subject, action) or data point (time, region, industry, indicator, value); other parts, such as the current situation and recommendations, are ordinary prose. The text cites 2026年10月31日《法新社》报道 without URLs, and 参考文献 at the end lists every source with title and URL.
- **Markdown first**: the draft lives in a Markdown file and later changes happen in place. The model is told beforehand to change an existing draft with edit, and replaces a whole one only when you ask for a rewrite. Write and edit text appears on the screen as the model produces it.
- **Copy on select**: selecting text with the mouse copies it. A Linux desktop needs no `xclip` (the text can be pasted while JiaWriter runs).
- **Sending during a reply**: `Esc` stops the reply and sends what is queued, leaving your draft in the input; `Ctrl+X Ctrl+S` (or `Ctrl+Enter`) stops it and sends the queue and the draft; `Up` on an empty input brings queued messages back for editing.
- **Going back**: every change saves the file first. Use `/rewind`, or just say "go back to the previous version". The state before going back is saved too.
- **Long conversations**: the context is compacted automatically when it fills up. Chinese is measured at its real size; oversized tool results are clipped in the request while the full text stays in the session and the topic folder; if the model summary fails, a local summary keeps the conversation going, at the cost of older details, which `/tree` still shows.

## Reference material

Put reference files in `参考资料/` (or `sources/`) in the writing folder. At startup and before every prompt JiaWriter imports new and changed files automatically into Markdown with page markers under `参考资料/.parsed/`, where `read` and `grep` find them, so citations can name a page. Imported text is treated as untrusted data, and instructions in it are not followed.

JiaWriter does no OCR: a scan without a text layer is listed in the import report and not imported; use a PDF or Word file with a text layer instead. Nothing you import leaves your computer.

## Export

Markdown drafts written or edited with `write` or `edit` in a run are exported to a .docx of the same name at the end of that run; notes, materials, outlines and files in the reference folders are left alone, and so is a draft the model exported after its last change.

`export_document` and `/export-doc` first convert punctuation to Chinese full-width marks: ASCII marks become Chinese ones, and a `-`, `–` or `--` between Chinese characters becomes `—`; numbers, times, versions, URLs, e-mail addresses, code, links, abbreviations and word-internal hyphens keep their form. Quotes are paired per paragraph, and an unpaired quote is reported for its paragraph only.

The export also does three more things:

- **Symbols**: LaTeX (such as `$\rightarrow$`, `$x^2$`, `\(a \leq b\)`), HTML entities (such as `&rarr;`) and Markdown escapes (such as `\_`) become characters Word shows directly (→, x², ≤, _). A price such as `$100` is no formula. LaTeX commands without a matching character are kept and listed in the report.
- **Spaces**: body text keeps spaces only between English words; there are none between Chinese and English or numbers, between Chinese characters, or around Chinese punctuation. Code keeps its spaces.
- **Layout and links**: a blank line follows the title; links become hyperlinks that open in Word, shown as "title (URL)".

The 参考文献 section at the end (also 参考资料, 资料来源, References and the like) is checked entry by entry: each needs a usable http(s) URL and a descriptive title (the page title, the publisher and the date), and the URL must be a page `fetch_web` opened in this session and got text from. Entries that fail are listed in the report; in interactive mode, URLs the automatic export at the end of a run finds unopened go back to the model, which opens each one: an entry stays when its page loads and matches the title, and is replaced with an opened source or removed otherwise. Each URL goes back once.

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

A skill's text is read only when needed; the system prompt holds a one-line index. A document with no named genre uses the 公文 skill (lieflat-gongwen) by default; turning that skill off in `/skills` drops the default too.

Four built-in skills, one set for every interface language, with their rules in English: the Chinese official-document skill [lieflat-gongwen](https://github.com/larashero3-dotcom/lieflat-gongwen) (调研报告, 领导讲话, 工作意见, 经验材料, 工作方案 and statutory documents such as 通知, with parameters from a corpus of official documents; the program checks drafts against them), deep research (research a question across sources and write a sourced report or news round-up), academic writing, and skill-creator. How analysis paragraphs are built is in the writing rules, so every document follows it. Your own skills go in `~/.jiawriter/agent/skills/<name>/SKILL.md` and take the place of a built-in skill with the same name.

A skill made from a session collects only what you wrote in the current session and the reasons you gave for refused tool calls, never model replies; keys, tokens and passwords are removed first, and for a repeated topic the latest request is kept. You review the draft before anything is written.

## Search

The model plans how to search and read for each question: it can rephrase the query, switch engines or switch methods and search several times. The tool descriptions give each method's strengths and costs and the rules for writing queries: 2–6 key terms, Chinese for Chinese sources and English for international ones, the year and month or the date plus a time filter for recent events, and `site:` for official sites.

- `search_web` has four methods, and the model names one on every call; none is the default:
  - `browser`: your own Chrome, with any of Bing, Google, Baidu and Sogou (several per search; Bing and Google when none is named). It needs the Chrome extension connected and works on all six platforms. The jiawriter program itself is the extension's native messaging host; a release build registers it with Chrome at startup (Chrome's NativeMessagingHosts folder on Linux and macOS, the current user's registry on Windows), with no Python or other dependency.
    - Searching works as a person does: open the engine's home page, move the mouse to the search box and click, type the query one character at a time, press Enter, scroll through the results and click "Next", 3–5 pages per engine. Characters are 0.14–0.32 s apart with an occasional pause of 0.5–1 s. The mouse moves on a curved path that speeds up and slows down, with a slight tremor, now and then overshooting a distant target and coming back; while reading, the hand drifts a little. A cookie consent dialog is accepted by clicking. Clicks, typing and scrolling go through the Input domain of `chrome.debugger`, so the page receives trusted events (isTrusted) like a real mouse and keyboard. Only the time filter (`fresh`) is added as the engine's parameter to the results address, because its menu is several clicks deep.
    - The search box, the search button, a cookie dialog's accept button and "Next" are found through what Chrome tells screen readers (the accessibility tree): each element's role (text field, button, link), its shown name and its place on screen; a "Next" without a name (Baidu draws only an arrow) is the link that leads to the next page of the same query. One set of rules serves all four engines, no CSS class names are read, and a site redesign does not break it; the results list is read from the accessibility tree as well (a heading with a link is one result, the other text in its block the snippet, blocks labelled as ads are skipped). Page code is read only where it is needed: when the accessibility tree has no matching control or no result, and to replace Baidu's and Sogou's redirect links with the real addresses. Sogou has no "Next": scrolling to the bottom loads more results. Baidu results carry their real addresses; Sogou's links are encrypted redirects, and reading one records the address it leads to.
    - The results of all engines are merged and ranked on this computer: BM25 of the query against title and snippet (0.45), reciprocal-rank fusion of the positions on the engines (0.35), and the share of query terms covered (0.20).
    - Two queries to the same engine are at least 45 seconds apart, two visits to the same site at least 20 seconds, both with random jitter; local and private network addresses are refused.
    - Human checks: the program judges a page by its make-up (status 401/403/429/503, or sent to a verification or login address, and a very small page), not by wording, so ordinary pages never wait. On a wall the Chrome window comes to the front or flashes in the task bar, the terminal rings and a status line counts down, for up to `JW_VERIFY_WAIT` seconds (180 by default), longer while you work in the window, at most 5 minutes. Each site waits once a run. If it is not cleared, or a page merely looks wrong, work goes on and the page stays open in Chrome; say when it is done and it is read again, and an engine set aside returns at your next message. Esc or Ctrl+C cancels at any time.
    - Before the first use, load the extension: open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and choose the package's `chrome-extension` folder. Check with `/browser`.
  - `anysearch`: the AnySearch API; fast, needs no Chrome, results carry no dates; anonymous when no key is set.
  - `claude` and `codex`: the upstream model searches by itself. The first time is a request of its own with the conversation's model and effort; after that the upstream's own tools join the main conversation, the model reads the pages itself, and the pages it read are archived in the original. Tell the model in your prompt (or `PROMPT_ADD`) that the upstream supports it; `claude` is for Claude models and `codex` for Codex and GPT models, whatever the real upstream is. API keys and OAuth-style upstreams both work: a plain request goes first, and one OAuth-style request follows on 401, 403 or 404.
- `fetch_web` has five methods, again with no default:
  - `browser`: open the page in Chrome. A result still shown on an open results page is clicked there and the tab goes back afterwards; other addresses open in a new tab. The page is scrolled a few times, then Readability (Firefox's reader-mode algorithm) extracts the text; PDF and Word documents are downloaded through Chrome and parsed on this computer.
  - `anysearch`: AnySearch's text extraction API.
  - `sf`: search_fetch, whose pages go through the same extension. It downloads and parses PDF, Word and Excel documents and reads the metadata and subtitles of videos; it does no OCR and no speech recognition. All six packages carry sf (`sf.exe` on Windows, which reaches the native host over a loopback port with a token). sf is a single self-contained file: Python and the packages it uses are inside. Its first run only unpacks that copy once into `~/.jiawriter/agent/sf/`; it downloads and installs nothing.
  - `claude`: the upstream's fetch tool returns the page text as served; pages built by JavaScript need `browser`, and PDFs need `sf`.
  - `codex`: as with `search_web`, after the first success the upstream's own search tool joins the main conversation and the model reads the pages itself. Where the conversation is not on the Responses API, Codex's `alpha/search` is used, with `lineno` to read on in a long page and `find` to look for words; where the upstream lacks that too, it opens the page and writes the text out, which can be shortened.
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

Exception: `skills/writer/lieflat-gongwen/`, `src/writer/gongwen/` and `src/extensions/writer-gongwen/` are under the [PolyForm Noncommercial License 1.0.0](packages/coding-agent/skills/writer/lieflat-gongwen/LICENSE), for noncommercial use only. Remove these three before commercial use, or get a license from the original author. `search_fetch/src/search_fetch/vendor/crawl4ai/html2text/` (inside sf) is under the GPL-3.0 (its COPYING file).
