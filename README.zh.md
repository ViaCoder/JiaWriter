# JiaWriter

[English](README.md) | 中文

JiaWriter 是一个通用写作 agent，在终端里运行。它读取参考资料、联网检索、起草和修改稿件、检查 AI 腔，最后导出 Word 文档。它基于 [pi](https://github.com/earendil-works/pi) v1.4.0 改造，采用 MIT 许可证。

- 成稿以中文为主，可以夹用英文术语，标点一律用中文全角；界面和工具输出默认中文，可切换英文。
- 文风客观、中立、清晰；引用的案例只取自参考资料或检索结果，正文写明日期和来源。
- 支持 Windows、macOS、Linux，每个系统都有 amd64 和 arm64 版本。

## 安装

1. 下载对应平台的包：`jiawriter-<平台>.tar.gz`（Linux、macOS）或 `jiawriter-<平台>.zip`（Windows），平台为 `linux-x64`、`linux-arm64`、`darwin-arm64`、`darwin-x64`、`windows-x64`、`windows-arm64`。包和 `SHA256SUMS` 在 GitHub Actions「JiaWriter packages」工作流的运行结果里。
2. 核对校验值：`sha256sum -c SHA256SUMS`（macOS 用 `shasum -a 256 -c SHA256SUMS`）。
3. 解压后运行 `jiawriter`（Windows 为 `jiawriter.exe`）。包里自带固定版本的 fd 和 ripgrep，运行时不下载任何工具。
4. 在 Chrome 里加载包里的 `chrome-extension` 文件夹（只需一次）。每个包都带一份中文的 `使用说明.html`，用截图写明了从设置模型到安装扩展的每一步。

## 配置模型

模型通过环境变量配置，支持 OpenAI Responses、OpenAI Chat Completions 和 Anthropic Messages 三种接口。

| 变量 | 含义 | 默认值 |
|---|---|---|
| `JW_URL` | API 地址 | 必填 |
| `JW_KEY` | API key | 必填 |
| `JW_MODEL` | 模型名 | 必填 |
| `JW_API` | 接口类型：`anthropic-messages`、`openai-responses`、`openai-completions` | 自动检测 |
| `JW_CTX` | 上下文窗口（token） | 128000 |
| `JW_OUT` | 最大输出（token） | 128000 |
| `JW_REASONING` | 推理档位：`off`、`low`、`medium`、`high`、`xhigh`、`max` | `medium` |
| `JW_LANG` | 界面和工具输出的语言：`zh`、`en` | `zh` |
| `JW_SEARCH` | 模型没有指定方式时的默认检索方式：`auto`、`browser`、`anysearch`；设为 `sf` 时，读网页默认用 sf | `auto` |
| `JW_ENGINES` | 模型没有指定引擎时，浏览器检索依次使用的引擎，可选 `bing`、`google`、`baidu`、`sogou` | `bing,google` |
| `JW_VERIFY_WAIT` | 遇到人机验证时等你处理的最长时间（秒，0–300，0 表示不等） | `90` |
| `JW_SEARCH_PAGES` | 浏览器检索每个引擎看几页结果（3–5） | `3` |
| `JW_AUTO_EXPORT` | 设为 `off` 时，每轮结束不再自动导出 docx | 开启 |
| `JW_SEARCH_KEY` | AnySearch 的 key | 不设则匿名调用 |
| `JW_SF` | search_fetch 程序的路径 | 在约定位置查找 |

设置方法（把示例值换成你自己的）：

- Linux、macOS（bash、zsh）：`export JW_URL="https://api.example.com"`，`export JW_KEY="<你的 API key>"`，`export JW_MODEL="<模型名>"`；长期使用写进 `~/.bashrc` 或 `~/.zshrc`。
- fish：`set -gx JW_URL https://api.example.com`，其余变量同理。
- Windows PowerShell：当前窗口用 `$env:JW_URL="https://api.example.com"`；长期使用用 `setx JW_URL "https://api.example.com"`，然后新开一个终端。
- Windows cmd：`set JW_URL=https://api.example.com`。

接口类型自动检测时，JiaWriter 向三个端点各发一次不合法的请求（输出上限为 0），服务器在参数校验阶段拒绝，不生成内容，不消耗 token；结果缓存在 `~/.jiawriter/agent/api-detect.json`，缓存里没有 key。

JiaWriter 启动时把 `JW_KEY` 和 `JW_SEARCH_KEY` 读进内存，随即从自己的环境变量里删除，所以它启动的 shell、sf、fd、rg 和 MCP 服务器等子进程都拿不到 key；key 也不写入任何文件，`/jw` 页面只显示“已设置”或“未设置”。

在 JiaWriter 里运行 `/jw`，可以查看每个变量当前生效的值和来源，以及本平台的设置命令。

## 写作工具

| 工具 | 作用 |
|---|---|
| `read`、`write`、`edit`、`ls`、`find`、`grep` | 读写和查找文件（`bash` 默认关闭，可在设置中开启） |
| `style_check` | 检查 AI 腔：对比框架（如“不是……而是”）、套话、否定式密度、列表和加粗的用量 |
| `word_count` | 分别统计汉字、英文词和数字，可按章节统计并与目标篇幅比对 |
| `readability_check` | 列出《通用规范汉字表》一级字以外的字和过长的句子，英文给出 Flesch 易读度 |
| `web_search`、`web_fetch` | 联网检索和读取网页正文 |
| `import_document` | 导入参考资料：PDF、Word（.docx）、HTML、txt、md |
| `export_document` | 把 Markdown 稿件导出为 docx 或 md |

## 命令

| 命令 | 作用 |
|---|---|
| `/jw` | 只读的配置页 |
| `/lang zh`、`/lang en` | 切换界面语言（设置了 `JW_LANG` 时以它为准） |
| `/skills` | 管理写作 skill：启用、停用、编辑、用当前会话更新、删除（删除前先备份） |
| `/skill-new` | 新建 skill：从当前会话生成、空白模板，或由模型按 skill-creator 编写 |
| `/browser` | Chrome 扩展是否连接，以及安装步骤 |
| `/import-doc [文件]` | 导入参考资料 |
| `/export-doc <稿件.md> [md\|docx] [--profile=方案] [--out=路径]` | 导出稿件 |
| `/sf status`、`/sf install` | 与 `/browser` 相同 |

## 参考资料

把资料放进写作文件夹下的 `参考资料/`（或 `sources/`）。JiaWriter 启动时和每次提问前都会自动导入新文件和改过的文件，结果是带页码标记的 Markdown，放在 `参考资料/.parsed/`，可以用 `read` 和 `grep` 查找，引用时可以写明页码。导入的内容按不可信数据处理，其中的指令一律不执行。

JiaWriter 不做文字识别（OCR）：没有文字层的扫描件会列在导入报告里，不导入，请换成带文字层的 PDF 或 Word 文件。导入的文件不会离开你的电脑。

## 导出

每一轮里用 `write` 或 `edit` 写过的 Markdown 稿件，会在这一轮结束时自动导出为同名 docx；笔记、素材、大纲和参考资料目录里的文件不导出，模型在最后一次修改之后已经导出过的稿件也不重复导出。

`export_document` 和 `/export-doc` 先把标点统一为中文全角：英文标点转成中文标点，汉字之间的 `-`、`–`、`--` 改为 `—`；数字、时间、版本号、URL、邮箱、代码、链接、缩写和英文词内的连字符保持原样；引号按段落配对，未配对的引号只在报告里列出所在段落。

导出时还会做三件事：

- **符号**：LaTeX 写法（如 `$\rightarrow$`、`$x^2$`、`\(a \leq b\)`）、HTML 实体（如 `&rarr;`）和 Markdown 转义（如 `\_`）换成 Word 能直接显示的字符（→、x²、≤、_）。`$100` 这样的价格不算公式。没有对应字符的 LaTeX 命令保留原样，并在报告里列出。
- **空格**：正文里只保留英文单词之间的空格；汉字与英文、数字之间，汉字之间，中文标点前后都不留空格。代码里的空格不动。
- **版式和链接**：大标题后空一行；链接写成 Word 里能点开的超链接，显示为“标题（网址）”。

文末的“参考文献”（也认“参考资料”“资料来源”“References”等）逐条检查：每条要有可用的 http(s) 网址和描述性标题（网页标题、发布机构和日期），网址还要是本次会话里用 `web_fetch` 打开过、取到了正文的网页。不合格的条目在报告里列出；交互模式下，每轮结束自动导出时发现还没打开过的网址，会交给模型逐个打开核对：能打开且与标题相符的保留，否则换成打开过的来源或删去。每个网址只交一次。

默认排版方案 `default-zh`：

| 层级 | 中文字体 | 字号 |
|---|---|---|
| 大标题（`#`） | 方正小标宋简体 | 二号（22 磅） |
| 一级标题（`##`） | 黑体 | 小二（18 磅） |
| 二级标题（`###`） | 楷体_GB2312 | 小二 |
| 三级标题（`####`） | 黑体 | 小二 |
| 正文 | 方正仿宋_GBK | 小二 |

英文和数字用 Times New Roman，全文固定行距 32 磅，A4 纸，页边距按 GB/T 9704-2012（上 37、下 35、左 28、右 26 毫米），页脚居中页码。字体按名称引用，没有替代字体，请在自己的电脑上安装并取得授权。自定义方案是一个 JSON 文件，只写要改的字段，例如 `{"lineSpacingPt": 28}`，用 `--profile=文件.json` 指定，或放在 `~/.jiawriter/agent/profiles/<名称>.json` 后用名称指定。

导出后程序会解开 docx 检查：每个含中文的文字段都带 `w:hint="eastAsia"` 和中文字体，统计紧邻汉字的英文标点和未配对的引号，并列出实际使用的字号和行距；稿件中出现“待核实”时会提示。

## 写作 skill

内置 9 个 skill，中英文各一套，按界面语言提供：通用文章、报告分析、新闻特稿、学术写作、商务邮件和备忘录、营销文案、叙事小说、skill-creator，以及公文写作 [lieflat-gongwen](https://github.com/larashero3-dotcom/lieflat-gongwen)。lieflat-gongwen 覆盖调研报告、领导讲话、工作意见、经验材料、工作方案、经验总结和千字级党建材料，参数来自公文语料统计，写完用 `gongwen_check` 工具自检；它的材料只有中文，英文界面也读中文目录。自己的 skill 放在 `~/.jiawriter/agent/skills/<名称>/SKILL.md`，同名时优先于内置版本。

从会话生成 skill 时，只收集你在当前会话里发出的内容和否决工具调用时附带的意见，模型回复不收集；key、令牌、密码一类内容先去掉；同一主题以最后一次要求为准。草稿先显示给你确认，确认后才写入。

## 检索

每次检索和读网页用哪种方式，由模型按问题自己规划：一个问题可以换关键词、换引擎、换方式查几次。工具说明里写明了每种方式的长处和代价，也给了写检索词的规则：用 2–6 个关键词，中文来源用中文、国际来源用英文，近期事件写进年月或日期并加时间筛选，需要时用 `site:` 限定官方网站。

- `web_search` 有两种方式：
  - `browser`：在你自己的 Chrome 里检索，引擎可选 Bing、Google、百度、搜狗，一次可以选几个，不指定时用 Bing 和 Google。需要 Chrome 扩展已连接，6 个平台都支持。JiaWriter 程序本身就是扩展的本机通信程序，发布版启动时会自动向 Chrome 注册（Linux、macOS 写 Chrome 的 NativeMessagingHosts 目录，Windows 写当前用户的注册表），不需要 Python 和其他依赖。
    - 检索像真人一样操作：打开引擎首页，把鼠标移到搜索框点击，一个字一个字地输入，回车，滚动阅读结果，再点“下一页”，每个引擎看 3–5 页。每个字之间隔 0.14–0.32 秒，偶尔停顿 0.5–1 秒。鼠标沿弧线移动，先加速后减速，带轻微抖动，距离较远时偶尔略过目标再移回来；读结果时手会随机小幅移动。有 cookie 同意弹窗时点“接受”。点击、输入和滚动都通过 `chrome.debugger` 的 Input 接口发送，页面收到的是和真实鼠标键盘相同的可信事件（isTrusted）。只有时间筛选（`fresh`）是在结果页地址上加引擎的筛选参数，因为它的菜单要点好几层。
    - 搜索框、搜索按钮、cookie 弹窗的“接受”和“下一页”，按 Chrome 提供给读屏软件的信息（无障碍树）来找：元素的角色（输入框、按钮、链接）、屏幕上显示的名字和在屏幕上的位置；“下一页”没有名字时（比如百度只画了一个箭头），找通向同一查询下一页的链接。四个引擎用同一套规则，不读网页的 CSS 类名，网站改版时不受影响；结果列表也先从无障碍树读：带链接的标题是一条结果，同一块里显示的其他文字是摘要，单独标着“广告”“推广”的跳过。只在真的需要时才读网页代码：无障碍树里找不到控件或一条结果都读不到时，以及把百度、搜狗的跳转链接换成原网址时。搜狗没有“下一页”，往下滚到底就会加载更多结果。百度结果给出原网址，搜狗的结果链接是加密跳转，读取时记下跳转后的原网址。
    - 各引擎的结果合并去重后，在本机打分排序：查询词与标题、摘要的 BM25 匹配度占 0.45，各引擎名次的倒数融合占 0.35，查询词覆盖率占 0.20。
    - 同一引擎两次检索至少间隔 20 秒，同一网站两次访问至少间隔 6 秒，都另加随机抖动；不打开内网和本机地址。
    - 人机验证：交互模式下，Chrome 窗口跳到前台，界面提示你在窗口里完成，最多等 `JW_VERIFY_WAIT` 秒（默认 90 秒），剩 30 秒时再提醒一次。完成后继续检索；按 Esc 取消这次检索。到时还没完成，就停止等待，这个引擎 30 分钟内不再使用，结果里写明原因，模型可以改用其他引擎或 AnySearch。print 模式（`-p`）不等人工处理。
    - 第一次使用前在 Chrome 加载扩展：打开 `chrome://extensions`，打开“开发者模式”，点“加载未打包的扩展程序”，选择包里的 `chrome-extension` 文件夹。用 `/browser` 确认已连接。
  - `anysearch`：调用 AnySearch API，速度快，不需要 Chrome，结果没有日期。不设 key 时匿名调用。
  - 模型没有指定方式时，按 `JW_SEARCH`：默认 `auto`，扩展已连接时用浏览器，否则用 AnySearch，并在结果开头说明。
- `web_fetch` 有三种方式：
  - `browser`：在 Chrome 里打开。结果页还开着并且有这条链接时，就在结果页上点开，读完后退回；其他网址在新标签页打开。页面加载后先滚动几下，再用 Readability（Firefox 阅读模式的算法）取出正文；PDF 和 Word 文档经 Chrome 下载后在本机解析。
  - `anysearch`：AnySearch 的正文抽取接口。
  - `sf`：search_fetch，网页同样经这个扩展打开。它下载并解析 PDF、Word、Excel 文档，读取视频的元数据和字幕，不做文字识别，也不做语音转写。6 个发布包都自带 sf（Windows 上是 `sf.exe`，经回环端口加令牌连接本机通信程序）。sf 是一个自带全部依赖的单文件程序：Python 和它用到的包都已打包在里面。第一次运行只在本机把这份内容解开一次，放在 `~/.jiawriter/agent/sf/`，不下载、不安装任何东西。
  - 读取失败或读到的文字很少时，模型可以换一种方式再读。
- 时间：每条用户消息发给模型时，开头带上它发出时的本地时间，例如 `[Sent 2026-11-03 18:42 Tuesday, Asia/Taipei, UTC+08:00]`，最新一条的时间就是“现在”；这段文字由消息自带的时间生成，每次都相同，不影响模型服务的提示词缓存。检索结果第一行写检索时间。模型服务器响应头里的时间和本机相差 2 分钟以上时，按服务器时间告诉模型，并提示你检查系统时间。

## 联网与隐私

JiaWriter 启动和空闲时不发任何网络请求，没有遥测、版本检查和上传功能。联网只有三类：你配置的模型 API、检索后端，以及你要求导入的网址；扫描件 OCR 会把页面图片发给公开的 Hugging Face Space。所有配置和会话都在 `~/.jiawriter/` 下；发布版启动时会向 Chrome 写一份很小的本机通信程序清单（见“检索”）。

## 平台与测试

每次推送到 dev 时，GitHub Actions 在 6 个平台上运行 JiaWriter 自己的测试，构建 6 个发布包，再在每个平台的原生机器上检查包：fd 和 ripgrep 能否运行，扩展、使用说明和参考资料文件夹是否在包里，`--version`、`--help`，对本机模拟模型服务器的一次写作运行和一轮导入 PDF、导出 docx、自动导出，以及扩展的本机通信程序（一个请求经程序转给模拟扩展再返回，陌生来源被拒绝；不需要 key，不调用真实模型）。每个平台另外运行一次包内的 sf；Windows 还实际执行一次使用说明里的 `setx`，Linux 和 macOS 还检查交互界面的中英文显示。上游 pi 的完整测试套件在 Linux 上运行。浏览器后端在开发机上用 Chrome for Testing 加本地仿 Bing、Google 页面做功能测试（页面收到的事件全部是可信事件）。

本仓库的开发机是 Linux x64，Linux 的设置命令在这台机器上实际测过；Windows 的 `setx` 在 CI 的 Windows 机器上执行过；macOS 的设置命令按 zsh 的语法写成，Windows cmd 的写法没有测过。

## 许可证

MIT，见 [LICENSE](LICENSE)，保留 pi 原作者的版权声明。发布包里不带许可证文件，各组件的许可证在本仓库或上游项目里：

- 本仓库：Readability（`search_fetch/src/search_fetch/extension/vendor/Readability-LICENSE.md`）、Unicode 数据（`packages/coding-agent/src/writer/data/UNICODE-LICENSE.txt`）、lieflat-gongwen（见下文），以及摘录到 `search_fetch/src/search_fetch/vendor/crawl4ai/` 的 crawl4ai 部分（crawl4ai 和 rank_bm25 为 Apache-2.0，html2text 为 GPL-3.0）；
- 上游项目：fd、ripgrep、unpdf（含 pdf.js 及其解码器）、docx、fflate、Python，以及 sf 内置的 Python 包（版本见 `search_fetch/pyproject.toml`）。

例外：`skills/writer/*/lieflat-gongwen/`、`src/writer/gongwen/` 和 `src/extensions/writer-gongwen/` 按 [PolyForm Noncommercial 1.0.0](packages/coding-agent/skills/writer/zh/lieflat-gongwen/LICENSE) 提供，只限非商业用途。商业使用前要删除这三处，或者向原作者取得授权。sf 里的 `search_fetch/src/search_fetch/vendor/crawl4ai/html2text/` 按 GPL-3.0 提供（见其中的 COPYING）。
