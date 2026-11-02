# search_fetch — WriterAgent 的检索后端（`WA_SEARCH=sf`）

WriterAgent 的 `web_search` / `web_fetch` 工具在 `WA_SEARCH=sf` 时以子进程调用本程序
（`sf search --json …`、`sf fetch --json …`，参数不经 shell，查询词和 URL 放在 `--` 之后）。
它通过 **search_fetch 扩展在你自己的 Chrome 专用窗口里**打开网页，再用 crawl4ai 转成 markdown：
真实浏览器、真实的 Cookie 与登录状态，产物全部落盘，可以复查。

**不使用驾驶模型（LLM），不需要 key**（2026-11-01 起）：页面状态由固定规则判断，翻页靠确定性信号。
以后需要驾驶模型时的接入点在 `browser.py` 的「Model hook」注释里说明。
不做 OCR，也不做语音转写：图片和扫描件只取文字层，没有文字层就按无内容处理；音视频只收录元数据和字幕。`kb` 子命令需要嵌入接口，WriterAgent 不使用它。

- **search** — 直接打开各引擎的结果页（Google、Startpage，可选 Brave、Bing、DuckDuckGo、百度、搜狗），
  用扩展内置的页面脚本取出结果链接，SERP 原样转成 markdown 返回，由调用方挑选结果。
  有 consent 弹窗时自动点“同意”；翻页依次尝试“下一页”链接、“更多结果”按钮和无限滚动。
- **fetch** — 打开任意 URL，转成 markdown；带 `--query` 时先 Pruning 去噪再用 BM25 只留相关片段。
  文档 URL（pdf/docx/pptx/xlsx/csv）交给 `docparse.py` 提取文字层；
  网页里链接的文档也会顺带下载解析（`SEARCH_FETCH_PAGE_DOCS`，默认 3 个）。
- **ingest** — 解析工作文件夹里的本地材料目录（参考资料/），输出带 `##### 来源：参考资料/<文件>` 标记的语料。

所有产物落在**调用方当前目录**的 `./.search_fetchres/`；WriterAgent 以写作文件夹为工作目录运行 sf。
**全部可变状态都在本目录内**：venv、扩展副本、桥接 socket、节流记录和缓存都在 `home/`
（`SEARCH_FETCH_HOME`），删除本目录即完全卸载。

## 浏览器与请求节奏

- 扩展（`src/search_fetch/extension`，MV3）经 native messaging 连接本机通信程序：在 WriterAgent 里是 writeragent 本身，
  单独使用 sf 时是 `sf bridge-host`（`home/bridge/bridge.sock`，目录 0700、socket 0600；设置 `SEARCH_FETCH_BRIDGE_SOCKET` 时改用它指定的 socket）；
  host 只接受本扩展的 origin。页面操作全部是扩展内置的静态脚本，不执行字符串代码。
- 点击、输入和滚动经 `chrome.debugger` 的 Input 接口发出（`human_click`、`human_type`、`human_scroll`），页面收到的是可信事件：
  鼠标沿曲线移到目标再点，逐字输入，滚轮滚动；不在页面里调用 `click()` 或直接改输入框的值。
- 节流（`pacing.py`，本机所有 sf 进程共享，记录在 `home/pacing/`）：同一搜索引擎两次查询至少间隔 45 秒，
  同一网站两次请求至少 8 秒，任意两次跳转至少 1.5 秒，均另加随机抖动；本机回环地址不节流。
- 验证码：search 命中时有界等待你在 Chrome 窗口里处理（默认 80 秒，`SEARCH_FETCH_HUMAN_WAIT`；
  WriterAgent 的 print 模式自动设 `SEARCH_FETCH_NO_HUMAN=1`）。fetch 对盘查页最多等
  `SEARCH_FETCH_FETCH_CHALLENGE_WAIT`（默认 45 秒），期满仍是带验证码框的盘查页才返回 `blocked:`；
  只凭措辞判断的疑似盘查短页按正文处理，不会丢失简短的真实页面。

## 布局

```
search_fetch/
├── sf.py                 # 源码入口 shim（把 src/ 加入 sys.path 后转交 __main__）
├── pyproject.toml        # 包定义 + 固定版本依赖
├── src/search_fetch/
│   ├── __main__.py       #   入口：rag.env 加载 + CLI 分发
│   ├── config.py         #   所有 SEARCH_FETCH_* 环境旋钮
│   ├── bridge.py         #   native messaging host + 本机 socket 客户端；`sf bridge install|status`
│   ├── extension/        #   MV3 扩展（background.js + ops/ 固定页面脚本）
│   ├── browser.py        #   经扩展打开的页面、页面状态判断、元素动作
│   ├── pacing.py         #   跨进程请求节流
│   ├── search.py         #   多引擎 SERP（URL 模板导航 + 分层翻页）
│   ├── fetch.py          #   URL → markdown（媒体 → 文档 → 浏览器）
│   ├── markdown.py / filters.py / artifacts.py   # 渲染、去噪与 BM25、落盘
│   ├── docparse.py / media.py                    # 文档解析、视频元数据与字幕
│   ├── url_guard.py      #   外连策略（只允许 http(s)，默认拒绝内网与本机地址，防 DNS 重绑定）
│   └── kb.py / ingest.py / known_urls.py / cli.py
├── tests/                # 隔离测试（见 tests/README.md）
├── rag.env.template      # 可选旋钮模板（复制为 rag.env；环境变量优先）
└── setup.sh              # 建 venv（home/）+ 装依赖 + 导入自检
```

## 快速开始

```bash
cd search_fetch
bash setup.sh                                  # venv 与依赖装进 ./home，并做导入自检
home/venv/bin/python3 sf.py bridge install     # 一次：复制扩展、写 native messaging 清单
# 按提示在 Chrome 打开 chrome://extensions →「开发者模式」→「加载未打包的扩展程序」，选它打印的目录
home/venv/bin/python3 sf.py bridge status      # connected=true 即可（保持 Chrome 开着）
```

在 WriterAgent 里使用：`WA_SEARCH=sf`，`WA_SF` 指向 sf 程序（源码开发时可指向一个调用
`home/venv/bin/python3 sf.py "$@"` 的脚本）。直接自测：

```bash
PY=home/venv/bin/python3
$PY sf.py fetch  "https://example.com/report"
$PY sf.py search "world news" --pages 1 --lang en --engine google,startpage
$PY sf.py selftest            # 各引擎 SERP 契约自检
```

## 发布包里的 sf

- WriterAgent 的 6 个发布包都带有 `search_fetch/<os>/<arch>/sf`（Windows 上是 `search_fetch/windows/<arch>/sf.exe`；PyApp 单文件，内嵌本包 wheel 和 CPython 3.12），`WA_SEARCH=sf` 时不设 `WA_SF` 也能找到。Windows ARM 的包用 x64 版 `sf.exe`（Windows 11 的 x64 仿真运行）：crawl4ai 0.9.0 需要的 lxml 5.x 和 tiktoken 都没有 win_arm64 安装包（2026-11-02 查 PyPI）。
- WriterAgent 运行 sf 时，把它的全部状态放在 `~/.writeragent/agent/sf/`：`runtime/`（PyApp 的 Python 和依赖）、`pip-cache/`、`home/`（扩展副本、桥接 socket、节流记录）。第一次运行会从 PyPI 安装依赖，约 1.1 GB，需要两三分钟。
- 在 WriterAgent 里，扩展的本机通信程序是 writeragent 本身（主机名 `com.writeragent.browser`，发布版启动时自动向 Chrome 注册）；sf 由 `SEARCH_FETCH_BRIDGE_SOCKET` 指向它的 socket（`~/.writeragent/agent/browser/bridge.sock`），Windows 上由 `SEARCH_FETCH_BRIDGE_FILE` 指向它写的端口文件（`bridge.json`，内含回环端口和令牌），不再自己注册；Windows 上 `sf bridge install` 和 `sf bridge-host` 只提示改用 WriterAgent。按包里的「使用说明.html」在 Chrome 加载 `chrome-extension` 文件夹后，用 `/browser` 确认已连接。
- 打包：`bash build_binary.sh [--out <目录>]` 在本机原生构建（Windows 上在 Git Bash 里运行），产物为 `<目录>/<os>/<arch>/sf`，Windows 上是 `sf.exe`。PyApp 固定为 v0.31.0 源码（校验 SHA256），用 `pyapp/Cargo.toml` 与 `pyapp/Cargo.lock` 替换上游的依赖清单：zip 升到 9、zstd 升到 0.14，bytes、quinn-proto、rustls、tar、time 升到修复版本，`cargo audit` 为 0 个漏洞（2026-11-01）。

## 产物（`./.search_fetchres/`）

- `search-*.md` / `search-*.ops.jsonl`：各引擎 SERP markdown / 每步动作与耗时。
- `search-*.<引擎>-p<页>-empty.md`：没取到结果链接的结果页原样保存（被拦、改版或确实无结果），不用重访就能判断原因。
- `<slug>_fit.md` / `<slug>_raw.md`：精简正文（带 query 时为 BM25 片段）/ 全量正文。
- `index.md`：采集清单。

## 配置

| 项 | 说明 |
|---|---|
| `SEARCH_FETCH_HOME` | 可变状态根，默认 `<本目录>/home`（勿设到会被清理的 tmp 目录） |
| `SEARCH_FETCH_REINSTALL` | 设 `1` 强制 setup.sh 重装依赖 |
| `SEARCH_FETCH_RUN_ID` | 运行标记：带这个标记打开的标签页由 `sf browser stop` 关闭，并删除 `home/runs/<id>/` |
| `SEARCH_FETCH_SEARCH_GAP` / `SEARCH_FETCH_HOST_GAP` / `SEARCH_FETCH_NAV_GAP` | 请求节流间隔（秒），见上文 |
| `SEARCH_FETCH_PACE_WAIT_MAX` | 单次节流等待上限，默认 90 秒 |
| `SEARCH_FETCH_CLICK_PAUSE` | 每次点击/按键前的停顿基数，默认 1.2 秒，实际为 1–2 倍随机值，不低于 1 秒 |
| `SEARCH_FETCH_ALLOW_PRIVATE` | 设 `1` 允许抓取内网/本机地址（默认拒绝；任何情况下只允许 http(s)） |
| `SEARCH_FETCH_ONLY_KNOWN_URLS` | 设 `1` 后 fetch 只接受本次运行搜索结果中出现过的 URL（防提示注入诱导外传） |
| `SEARCH_FETCH_HUMAN_WAIT` / `SEARCH_FETCH_NO_HUMAN` | search 验证码人工等待上限（80 秒）/ 设 `1` 完全无人值守 |
| `SEARCH_FETCH_FETCH_CHALLENGE_WAIT` | fetch 盘查页等待上限（默认 45 秒） |
| `SEARCH_FETCH_ENGINE_CONCURRENCY` | 并发引擎数，默认 `1`（顺序） |
| `SEARCH_FETCH_PAGE_DOCS` | fetch 网页时顺带下载页内文档的上限，默认 `3`；`0` 关闭 |
| `SEARCH_FETCH_DOC_MAX_MB` | 单个文档下载上限（MB），默认 `40` |

## 排错

| 现象 | 处理 |
|---|---|
| 找不到依赖 | 跑 `bash setup.sh` |
| bridge not connected | 运行 `sf bridge install`，在 chrome://extensions 加载它打印的目录；保持 Chrome 开着，用 `sf bridge status` 检查 |
| 某引擎结果少/空 | 看 `search-*.ops.jsonl` 是否卡在验证页；`sf.py selftest --engine <名>` 定位 |

## 视频

媒体 URL（YouTube、直链音视频）走 `media.py`：只取元数据和字幕（人工字幕优先），不下载媒体，也不做语音转写；
没有字幕时只收录元数据与简介。字幕语言偏好用 `SEARCH_FETCH_SUB_LANGS` 设置（默认 `zh,en`）。

来源：从 WriterSuite 的 search_fetch（提交 0a0f160）复制而来，此后只在 WriterAgent 中维护。
