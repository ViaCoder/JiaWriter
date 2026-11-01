# WriterAgent

[English](README.md) | 中文

WriterAgent 是一个通用写作 agent，在终端里运行。它读取参考资料、联网检索、起草和修改稿件、检查 AI 腔，最后导出 Word 文档。它基于 [pi](https://github.com/earendil-works/pi) v1.4.0 改造，采用 MIT 许可证。

- 成稿以中文为主，可以夹用英文术语，标点一律用中文全角；界面和工具输出默认中文，可切换英文。
- 文风客观、中立、清晰；引用的案例只取自参考资料或检索结果，正文写明日期和来源。
- 支持 Windows、macOS、Linux，每个系统都有 amd64 和 arm64 版本。

## 安装

1. 下载对应平台的包：`writeragent-<平台>.tar.gz`（Linux、macOS）或 `writeragent-<平台>.zip`（Windows），平台为 `linux-x64`、`linux-arm64`、`darwin-arm64`、`darwin-x64`、`windows-x64`、`windows-arm64`。包和 `SHA256SUMS` 在 GitHub Actions「WriterAgent packages」工作流的运行结果里。
2. 核对校验值：`sha256sum -c SHA256SUMS`（macOS 用 `shasum -a 256 -c SHA256SUMS`）。
3. 解压后运行 `writeragent`（Windows 为 `writeragent.exe`）。包里自带固定版本的 fd 和 ripgrep，运行时不下载任何工具。

## 配置模型

模型通过环境变量配置，支持 OpenAI Responses、OpenAI Chat Completions 和 Anthropic Messages 三种接口。

| 变量 | 含义 | 默认值 |
|---|---|---|
| `WA_URL` | API 地址 | 必填 |
| `WA_KEY` | API key | 必填 |
| `WA_MODEL` | 模型名 | 必填 |
| `WA_API` | 接口类型：`anthropic-messages`、`openai-responses`、`openai-completions` | 自动检测 |
| `WA_CTX` | 上下文窗口（token） | 128000 |
| `WA_OUT` | 最大输出（token） | 128000 |
| `WA_REASONING` | 推理档位：`off`、`low`、`medium`、`high`、`xhigh`、`max` | `medium` |
| `WA_LANG` | 界面和工具输出的语言：`zh`、`en` | `zh` |
| `WA_SEARCH` | 检索后端：`anysearch`、`sf` | `anysearch` |
| `WA_SEARCH_KEY` | AnySearch 的 key | 不设则匿名调用 |
| `WA_SF` | search_fetch 程序的路径 | 在约定位置查找 |

设置方法（把示例值换成你自己的）：

- Linux、macOS（bash、zsh）：`export WA_URL="https://api.example.com"`，`export WA_KEY="<你的 API key>"`，`export WA_MODEL="<模型名>"`；长期使用写进 `~/.bashrc` 或 `~/.zshrc`。
- fish：`set -gx WA_URL https://api.example.com`，其余变量同理。
- Windows PowerShell：当前窗口用 `$env:WA_URL="https://api.example.com"`；长期使用用 `setx WA_URL "https://api.example.com"`，然后新开一个终端。
- Windows cmd：`set WA_URL=https://api.example.com`。

接口类型自动检测时，WriterAgent 向三个端点各发一次不合法的请求（输出上限为 0），服务器在参数校验阶段拒绝，不生成内容，不消耗 token；结果缓存在 `~/.writeragent/agent/api-detect.json`，缓存里没有 key。key 只从环境变量读取，不写入任何文件。

在 WriterAgent 里运行 `/wa`，可以查看每个变量当前生效的值和来源，以及本平台的设置命令。

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
| `/wa` | 只读的配置页 |
| `/lang zh`、`/lang en` | 切换界面语言（设置了 `WA_LANG` 时以它为准） |
| `/skills` | 管理写作 skill：启用、停用、编辑、用当前会话更新、删除（删除前先备份） |
| `/skill-new` | 新建 skill：从当前会话生成、空白模板，或由模型按 skill-creator 编写 |
| `/import-doc [文件]` | 导入参考资料 |
| `/export-doc <稿件.md> [md\|docx] [--profile=方案] [--out=路径]` | 导出稿件 |
| `/sf status`、`/sf install` | search_fetch 的 Chrome 扩展桥接 |

## 参考资料

把资料放进写作文件夹下的 `参考资料/`（或 `sources/`）。WriterAgent 启动时会在后台导入新文件和改过的文件，结果是带页码标记的 Markdown，放在 `参考资料/.parsed/`，可以用 `read` 和 `grep` 查找，引用时可以写明页码。导入的内容按不可信数据处理，其中的指令一律不执行。

没有文字层的扫描件需要 OCR。设置了 search_fetch（`WA_SF`，或使用发布包里自带的 sf）时，`import_document` 会调用它的 OCR，页面图片会上传到公开的 Hugging Face Space；启动时的后台导入不做 OCR。

## 导出

`export_document` 和 `/export-doc` 先把标点统一为中文全角：英文标点转成中文标点，汉字之间的 `-`、`–`、`--` 改为 `—`；数字、时间、版本号、URL、邮箱、代码、链接、缩写和英文词内的连字符保持原样；引号按段落配对，未配对的引号只在报告里列出所在段落。

默认排版方案 `default-zh`：

| 层级 | 中文字体 | 字号 |
|---|---|---|
| 大标题（`#`） | 方正小标宋简体 | 二号（22 磅） |
| 一级标题（`##`） | 黑体 | 小二（18 磅） |
| 二级标题（`###`） | 楷体_GB2312 | 小二 |
| 三级标题（`####`） | 黑体 | 小二 |
| 正文 | 方正仿宋_GBK | 小二 |

英文和数字用 Times New Roman，全文固定行距 32 磅，A4 纸，页边距按 GB/T 9704-2012（上 37、下 35、左 28、右 26 毫米），页脚居中页码。字体按名称引用，没有替代字体，请在自己的电脑上安装并取得授权。自定义方案是一个 JSON 文件，只写要改的字段，例如 `{"lineSpacingPt": 28}`，用 `--profile=文件.json` 指定，或放在 `~/.writeragent/agent/profiles/<名称>.json` 后用名称指定。

导出后程序会解开 docx 检查：每个含中文的文字段都带 `w:hint="eastAsia"` 和中文字体，统计紧邻汉字的英文标点和未配对的引号，并列出实际使用的字号和行距；稿件中出现“待核实”时会提示。

## 写作 skill

内置 8 个 skill，中英文各一套，按界面语言提供：通用文章、报告分析、新闻特稿、学术写作、商务邮件和备忘录、营销文案、叙事小说、skill-creator。自己的 skill 放在 `~/.writeragent/agent/skills/<名称>/SKILL.md`，同名时优先于内置版本。

从会话生成 skill 时，只收集你在当前会话里发出的内容和否决工具调用时附带的意见，模型回复不收集；key、令牌、密码一类内容先去掉；同一主题以最后一次要求为准。草稿先显示给你确认，确认后才写入。

## 检索

- `anysearch`（默认）：调用 AnySearch API，不设 key 时匿名调用。
- `sf`：search_fetch 在你自己的 Chrome 里打开网页，通过扩展和本机桥接取回内容，请求间隔有节流。Linux 和 macOS 的发布包自带 sf，Windows 暂不支持。第一次使用前运行 `/sf install`，按提示在 Chrome 的扩展页面加载扩展，再用 `/sf status` 确认已连接。sf 第一次运行会安装依赖，约 1.1 GB，需要几分钟，全部放在 `~/.writeragent/agent/sf/`。

## 联网与隐私

WriterAgent 启动和空闲时不发任何网络请求，没有遥测、版本检查和上传功能。联网只有三类：你配置的模型 API、检索后端，以及你要求导入的网址；扫描件 OCR 会把页面图片发给公开的 Hugging Face Space。所有配置和会话都在 `~/.writeragent/` 下。

## 平台与测试

每次推送到 dev 时，GitHub Actions 在 6 个平台上运行 WriterAgent 自己的测试，构建 6 个发布包，再在每个平台的原生机器上检查包：fd 和 ripgrep 能否运行，`--version`、`--help`，以及对本机模拟模型服务器的一次写作运行和一轮导入 PDF、导出 docx（不需要 key，不调用真实模型）。Linux 和 macOS 另外检查交互界面的中英文显示和包内的 sf。上游 pi 的完整测试套件在 Linux 上运行。

本仓库的开发机是 Linux x64，Linux 的设置命令在这台机器上实际测过；macOS 和 Windows 的设置命令按各自 shell 的语法写成，Windows 的 `setx` 和 cmd 写法没有在真实机器上测过。

## 许可证

MIT，见 [LICENSE](LICENSE)，保留 pi 原作者的版权声明。发布包的 `THIRD_PARTY/` 目录包含 fd、ripgrep、unpdf（含 pdf.js 及其解码器）、docx、fflate 和 Unicode 数据的许可证。
