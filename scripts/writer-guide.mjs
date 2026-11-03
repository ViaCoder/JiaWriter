#!/usr/bin/env node
// JiaWriter: the Chinese install guide of one release package (使用说明.html). One self-contained
// HTML file with the screenshots of packages/coding-agent/guide embedded, and the commands of the
// package's own system only. Usage: node scripts/writer-guide.mjs <platform> <out.html>

// Files.
import { readFileSync, writeFileSync } from "node:fs";
// Paths.
import { dirname, join, resolve } from "node:path";
// This script's folder.
import { fileURLToPath } from "node:url";

// The screenshots.
const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/coding-agent/guide");

/** HTML-escape text. */
export function esc(s) {
	// The five special characters.
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** An embedded PNG as an <img> tag. */
export function img(file, alt) {
	// Base64 data URL.
	const data = readFileSync(join(SHOTS, file)).toString("base64");
	return `<img src="data:image/png;base64,${data}" alt="${esc(alt)}">`;
}

/** A command block the reader copies. */
const code = (lines) => `<pre>${esc(lines.join("\n"))}</pre>`;

/** System-specific parts of the guide for a package platform (linux-x64, darwin-arm64, windows-x64 …). */
export function systemParts(platform) {
	// Windows: PowerShell, the exe, SmartScreen.
	if (platform.startsWith("windows-")) {
		return {
			system: "Windows",
			unpack: "在下载的 zip 文件上点右键，选“全部解压缩”，解压到一个固定的位置，例如“文档”里的 jiawriter 文件夹。以后不要移动这个文件夹。",
			safety:
				"第一次打开 jiawriter.exe 时，如果出现“Windows 已保护你的电脑”，点“更多信息”，再点“仍要运行”。",
			terminal: "在开始菜单里搜索“PowerShell”并打开，依次粘贴下面三行，每行回车一次（把引号里的内容换成你自己的）：",
			env: code([
				'setx JW_URL "https://api.example.com"',
				'setx JW_KEY "你的 API key"',
				'setx JW_MODEL "模型名"',
			]),
			envAfter: "每行都显示“成功”字样就设置好了。关掉这个 PowerShell 窗口，设置在之后打开的程序里生效。",
			run: "双击解压文件夹里的 jiawriter.exe，出现输入框就可以开始了。",
			pick: "选择文件夹",
		};
	}
	// macOS and Linux: a terminal and the shell's startup file.
	const mac = platform.startsWith("darwin-");
	const rc = mac ? "~/.zshrc" : "~/.bashrc";
	return {
		system: mac ? "macOS" : "Linux",
		unpack: mac
			? "在“下载”文件夹里双击下载的 tar.gz 文件，会得到一个 jiawriter 文件夹。以后不要移动这个文件夹。"
			: "把 tar.gz 文件解压到一个固定的位置，例如 ~/jiawriter。以后不要移动这个文件夹。",
		safety: mac
			? `macOS 会拦住从网上下载的程序。打开“终端”（在“启动台”里搜索“终端”），粘贴下面一行并回车，解除拦截：${code(["xattr -dr com.apple.quarantine ~/Downloads/jiawriter"])}如果文件夹不在“下载”里，把路径换成它实际的位置。`
			: "",
		terminal: `打开${mac ? "“终端”" : "终端"}，依次粘贴下面四行，每行回车一次（把引号里的内容换成你自己的）：`,
		env: code([
			`echo 'export JW_URL="https://api.example.com"' >> ${rc}`,
			`echo 'export JW_KEY="你的 API key"' >> ${rc}`,
			`echo 'export JW_MODEL="模型名"' >> ${rc}`,
			`source ${rc}`,
		]),
		envAfter: "以后每次打开终端都会自动带上这三个设置。",
		run: `在终端里进入解压文件夹并运行：${code([mac ? "cd ~/Downloads/jiawriter" : "cd ~/jiawriter", "./jiawriter"])}出现输入框就可以开始了。`,
		pick: "选择",
	};
}

/** The whole guide for a platform. */
export function guideHtml(platform) {
	// Parts for this system.
	const p = systemParts(platform);
	// Numbered sections.
	const sections = [
		["解压", `<p>${p.unpack}</p>${p.safety ? `<p>${p.safety}</p>` : ""}`],
		[
			"设置模型",
			`<p>JiaWriter 需要一个大模型服务。向你的模型服务商要三样东西：API 地址、API key 和模型名。支持 OpenAI 和 Anthropic 两种接口，程序会自动识别。</p><p>${p.terminal}</p>${p.env}<p>${p.envAfter}</p>`,
		],
		[
			"运行 JiaWriter",
			`<p>${p.run}</p><p>第一次运行时，程序会自动让 Chrome 认识它，不用做别的设置。</p>`,
		],
		[
			"安装 Chrome 扩展（只需一次）",
			`<p>JiaWriter 通过这个扩展用你自己的 Chrome 上网检索：先查 Bing，再查 Google，每个引擎看 3 到 5 页结果。没有安装扩展时，它会改用 AnySearch 检索。</p>
<p>① 打开 Chrome，在地址栏输入 <code>chrome://extensions</code> 并回车。打开右上角的“开发者模式”开关：</p>${img("1-devmode.png", "打开开发者模式")}
<p>② 点左上角的“加载未打包的扩展程序”，在弹出的窗口里选中解压文件夹里的 <b>chrome-extension</b> 文件夹，点“${p.pick}”：</p>${img("2-load.png", "加载未打包的扩展程序")}
<p>③ 列表里出现 JiaWriter 就装好了：</p>${img("3-loaded.png", "JiaWriter 扩展已加载")}
<p>使用时保持 Chrome 开着。检索时 Chrome 会多出一个窗口，JiaWriter 在里面打开网页，请不要关掉它。如果网站要求人机验证，Chrome 窗口会自动跳到前面，在里面完成验证即可。</p>`,
		],
		[
			"开始写作",
			`<p>直接用中文说出要求，例如“写一篇 2000 字的调研报告，主题是……”。</p>
<p>参考资料放进解压文件夹里的“参考资料”文件夹，支持 PDF、Word、网页和文本文件。每次提问前程序都会自动导入新放进去的资料。</p>
<p>每一轮写完或改完的稿件会自动导出成同名的 Word 文件（.docx），和稿件放在一起。</p>`,
		],
		[
			"遇到问题",
			`<p>在 JiaWriter 里输入 <code>/browser</code> 并回车，可以看到扩展是否已连接，以及安装步骤。输入 <code>/jw</code> 可以查看模型设置是否生效。</p>
<p>移动了解压文件夹以后，要在 chrome://extensions 里把 JiaWriter 移除，再按第 4 步重新加载一次。</p>`,
		],
	];
	// The page.
	const body = sections.map(([title, html], i) => `<h2>${i + 1}. ${esc(title)}</h2>\n${html}`).join("\n");
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>JiaWriter 使用说明（${esc(p.system)}）</title>
<style>
body { font: 16px/1.75 -apple-system, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif; max-width: 860px; margin: 32px auto; padding: 0 20px; color: #222; }
h1 { font-size: 28px; } h2 { font-size: 21px; margin-top: 36px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
pre { background: #f4f4f4; border: 1px solid #ddd; border-radius: 6px; padding: 12px 14px; overflow-x: auto; font-size: 15px; }
code { background: #f4f4f4; padding: 1px 5px; border-radius: 4px; }
img { max-width: 100%; border: 1px solid #ccc; border-radius: 6px; margin: 8px 0 16px; }
</style></head><body>
<h1>JiaWriter 使用说明（${esc(p.system)}）</h1>
<p>JiaWriter 是一个写作助手：读参考资料、上网检索、起草和修改稿件，最后导出 Word 文件。按下面的步骤做一次，以后直接运行即可。</p>
${body}
</body></html>
`;
}

// Command line: write the guide.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [platform, out] = process.argv.slice(2);
	if (!platform || !out) {
		console.error("usage: node scripts/writer-guide.mjs <platform> <out.html>");
		process.exit(2);
	}
	writeFileSync(out, guideHtml(platform));
}
