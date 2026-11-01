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
| `WA_SEARCH` | Search backend: `anysearch`, `sf` | `anysearch` |
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
| `/import-doc [file]` | Import reference files |
| `/export-doc <draft.md> [md\|docx] [--profile=name] [--out=path]` | Export a draft |
| `/sf status`, `/sf install` | Chrome extension bridge of search_fetch |

## Reference material

Put reference files in `参考资料/` (or `sources/`) in the writing folder. At startup WriterAgent imports new and changed files in the background into Markdown with page markers under `参考资料/.parsed/`, where `read` and `grep` find them, so citations can name a page. Imported text is treated as untrusted data, and instructions in it are not followed.

A scan without a text layer needs OCR. With search_fetch configured (`WA_SF`, or the sf in the release package), `import_document` uses its OCR, which uploads the page images to a public Hugging Face Space; the background import at startup does no OCR.

## Export

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

Eight built-in skills ship in Chinese and English and follow the interface language: general article, report and analysis, news and features, academic writing, business email and memos, marketing copy, narrative fiction, and skill-creator. Your own skills go in `~/.writeragent/agent/skills/<name>/SKILL.md` and take the place of a built-in skill with the same name.

A skill made from a session collects only what you wrote in the current session and the reasons you gave for refused tool calls, never model replies; keys, tokens and passwords are removed first, and for a repeated topic the latest request is kept. You review the draft before anything is written.

## Search

- `anysearch` (default): the AnySearch API, anonymously when no key is set.
- `sf`: search_fetch opens pages in your own Chrome through an extension and a local bridge, with paced requests. The Linux and macOS packages include sf; Windows is not supported yet. Before the first use, run `/sf install`, load the extension in Chrome's extensions page as shown, and check with `/sf status`. The first sf run installs its dependencies (about 1.1 GB, a few minutes), all under `~/.writeragent/agent/sf/`.

## Network and privacy

WriterAgent sends no network request at startup or while idle, and has no telemetry, version check or upload. It goes online only for your configured model API, the search backend, and URLs you ask it to import; OCR of scans sends page images to a public Hugging Face Space. All configuration and sessions live under `~/.writeragent/`.

## Platforms and testing

On every push to dev, GitHub Actions runs WriterAgent's own tests on all six platforms, builds the six packages, and checks each package on its own platform: fd and ripgrep run, `--version`, `--help`, one writing run against a local mock model server, and one round of PDF import and docx export (no key, no real model). On Linux and macOS it also checks the interactive interface in both languages and the bundled sf. The full upstream pi test suite runs on Linux.

The development machine is Linux x64, where the Linux setup commands were run; the macOS and Windows commands follow each shell's syntax, and the Windows `setx` and cmd forms have not been run on a real machine.

## License

MIT, see [LICENSE](LICENSE), with pi's original copyright notice kept. The `THIRD_PARTY/` folder of each package holds the licenses of fd, ripgrep, unpdf (with pdf.js and its decoders), docx, fflate and the Unicode data.
