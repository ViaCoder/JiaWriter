/**
 * Chinese text for the parts of the upstream interface users see most: key hints, the startup help
 * and the descriptions of the built-in and JiaWriter commands. The upstream code keeps its English
 * strings; uiText() looks each one up when the interface language is Chinese and leaves unknown
 * strings unchanged, so upstream additions show in English until they are added here.
 */

// The JiaWriter name in a release package.
import { brandText } from "./brand.ts";
// Current interface language.
import { currentLang } from "./i18n/index.ts";

/** English interface text → Chinese. {name} marks a value filled in by uiText(). */
export const UI_ZH: Readonly<Record<string, string>> = {
	// Startup help, full form.
	"to interrupt": "中断",
	"to clear": "清空输入",
	"to interrupt or clear": "中断或清空输入",
	"Press {key} again to exit": "再按一次 {key} 退出",
	"to exit": "退出",
	"to exit (empty)": "退出（输入为空时）",
	"to suspend": "挂起",
	"to delete to end": "删除到行尾",
	"to cycle thinking level": "切换推理档位",
	"to cycle models": "切换模型",
	"to select model": "选择模型",
	"to expand tools": "展开工具输出",
	"to expand thinking": "展开推理过程",
	"for external editor": "用外部编辑器编辑",
	"for commands": "命令",
	"to run bash": "运行 shell 命令",
	"to run bash (no context)": "运行 shell 命令（不进上下文）",
	"to queue follow-up": "排队发送下一条",
	"to edit all queued messages": "编辑排队中的消息",
	"to paste files on macOS, images, or text": "粘贴文件（macOS）、图片或文本",
	"to attach": "附加文件",
	// Startup help, compact form.
	interrupt: "中断",
	"clear/exit": "清空/退出",
	commands: "命令",
	bash: "shell",
	more: "更多",
	// Startup onboarding.
	"Press {key} to show full startup help.": "按 {key} 查看完整的启动帮助。",
	"Press {key} to show full startup help and loaded resources.": "按 {key} 查看完整的启动帮助和已加载的资源。",
	"Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.":
		"可以直接问它自身有哪些功能、怎么使用，它会查阅自带的文档回答。",
	// Hints in tool output and dialogs.
	"to expand": "展开",
	"to collapse": "收起",
	"to copy": "复制",
	"to cancel": "取消",
	"to cancel,": "取消，",
	"to close": "关闭",
	"to submit": "提交",
	back: "返回",
	cancel: "取消",
	close: "关闭",
	confirm: "确认",
	delete: "删除",
	navigate: "移动",
	newline: "换行",
	rename: "重命名",
	save: "保存",
	scope: "范围",
	select: "选择",
	sort: "排序",
	stop: "停止",
	submit: "提交",
	toggle: "切换",
	"switch mode": "切换模式",
	"external editor": "外部编辑器",
	named: "已命名",
	"skip setup": "跳过设置",
	"cycle inherit/+/-": "切换 继承/+/-",
	"load/unload/download": "加载/卸载/下载",
	// Built-in commands.
	"Open settings menu": "打开设置菜单",
	"Select model (opens selector UI)": "选择模型（打开选择界面）",
	"Navigate session tree (switch branches)": "浏览会话树（切换分支）",
	"Set thinking level": "设置推理档位",
	"Set the thinking intensity: /effort off, low, medium, high, xhigh or max":
		"设置思考强度：/effort off、low、medium、high、xhigh 或 max",
	"Enable/disable models for Ctrl+P cycling": "设置 Ctrl+P 轮换的模型",
	"Export session (HTML default, or specify path: .html/.jsonl)": "导出会话（默认 HTML，也可指定 .html/.jsonl 路径）",
	"Import and resume a session from a JSONL file": "从 JSONL 文件导入并继续会话",
	"Copy last agent message to clipboard": "复制最后一条回复到剪贴板",
	"Set session display name": "设置会话名称",
	"Show session info and stats": "查看会话信息和统计",
	"Show changelog entries": "查看更新记录",
	"Show all keyboard shortcuts": "查看全部快捷键",
	"Create a new fork from a previous user message": "从之前的一条消息分出新会话",
	"Duplicate the current session at the current position": "在当前位置复制会话",
	"Save project trust decision for future sessions": "记住对本项目的信任设置",
	"Configure provider authentication": "配置服务商登录",
	"Remove provider authentication": "移除服务商登录",
	"Start a new session": "开始新会话",
	"Manually compact the session context": "手动压缩会话上下文",
	"Resume a different session": "继续另一个会话",
	"Reload keybindings, extensions, skills, prompts, themes, and context files":
		"重新加载快捷键、扩展、skill、提示词、主题和上下文文件",
	"Quit {app}": "退出 {app}",
	// JiaWriter commands.
	"Import reference files (参考资料/ or one file) as Markdown with page markers":
		"导入参考资料（参考资料/ 或单个文件），转成带页码标记的 Markdown",
	"Export a Markdown draft: /export-doc <draft.md> [md|docx] [--profile=name] [--out=path]":
		"导出 Markdown 稿件：/export-doc <稿件.md> [md|docx] [--profile=方案] [--out=路径]",
	"Manage writing skills: turn on or off, edit, update from this session, delete":
		"管理写作 skill：启用、停用、编辑、用当前会话更新、删除",
	"Create a writing skill from this session, a blank template, or with skill-creator":
		"新建写作 skill：从当前会话生成、空白模板，或由 skill-creator 引导",
	"Switch the interface language: /lang zh or /lang en": "切换界面语言：/lang zh 或 /lang en",
	"Show the JiaWriter model and search configuration (read-only)": "查看 JiaWriter 的模型和检索配置（只读）",
	"search_fetch Chrome bridge: /sf status, or /sf install to set up the extension":
		"search_fetch 的 Chrome 桥接：/sf status 查看状态，/sf install 安装扩展",
};

/** text in the interface language: the Chinese entry of UI_ZH when the language is Chinese, else text; {name} filled from vars. */
export function uiText(text: string, vars: Readonly<Record<string, string>> = {}): string {
	// Chinese entry when there is one.
	const chosen = currentLang() === "zh" ? (UI_ZH[text] ?? text) : text;
	// Placeholders, then the product name of a release package.
	return brandText(chosen.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole));
}

/** Upstream's compaction failure messages in Chinese, keeping the reason after the prefix. */
export function compactionErrorText(message: string): string {
	// English interface: as upstream wrote it.
	if (currentLang() !== "zh") return message;
	// Whole sentences first, then the prefixes.
	return message
		.replace(
			/^Context overflow recovery failed after one compact-and-retry attempt\..*$/,
			"压缩后内容仍然超出上下文，这条消息没有发送成功。请重新发送，或先开始新会话。",
		)
		.replace(
			/^Truncated response recovery failed after one compact-and-retry attempt\.$/,
			"回复被截断，压缩后重试仍未成功。请重新发送。",
		)
		.replace(/^Context overflow recovery failed: /, "超出上下文后的压缩失败：")
		.replace(/^Auto-compaction failed: /, "自动压缩失败：")
		.replace(/^Compaction failed: /, "压缩失败：");
}
