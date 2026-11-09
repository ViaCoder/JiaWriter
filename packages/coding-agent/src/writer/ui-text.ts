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

/** The Mac note under the shortcut list (English; UI_ZH holds the Chinese). */
export const MAC_OPTION_NOTE =
	'On a Mac, Option shortcuts need the terminal\'s "Use Option as Meta Key": Terminal: Settings → Profiles → Keyboard; iTerm2: Settings → Profiles → Keys → General, both Option keys set to Esc+. Without it, Ctrl+J or \\ then Enter gives a new line, and /model switches the model.';

/** English interface text → Chinese. {name} marks a value filled in by uiText(). */
export const UI_ZH: Readonly<Record<string, string>> = {
	// The two answers of a confirmation.
	Yes: "是",
	No: "否",
	// The folded reasoning, an interrupted reply, and the way back to the end of the history.
	"Thinking...": "思考过程已折叠",
	"Operation aborted": "已中断",
	"Aborted after {count} retry attempt": "已中断（此前重试 {count} 次）",
	"Aborted after {count} retry attempts": "已中断（此前重试 {count} 次）",
	"↓ Jump to latest message": "↓ 回到最新消息",
	// Collapsed lines of a skill, a compaction summary and a branch summary.
	"[skill]": "[技能]",
	"Compacted from {tokens} tokens": "上下文已压缩，原 {tokens} token",
	"Branch summary": "分支摘要",
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
	"Copied!": "已复制",
	"to send queued messages now": "立即发送排队消息和草稿",
	"{keys} to edit, {send} to send now": "{keys} 编辑，{send} 立即发送",
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
	"Enable/disable models for Ctrl+P cycling": "设置可轮换的模型",
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
	// The shortcut list (? or /hotkeys), grouped as Claude Code's.
	"Keyboard Shortcuts": "快捷键",
	Key: "按键",
	Action: "作用",
	General: "常用",
	Editing: "输入与编辑",
	History: "查看历史",
	"Send message": "发送",
	"New line": "换行",
	"Stop the reply, or close a dialog": "停止回复，或关闭对话框",
	"Clear the input, or rewind when it is empty": "清空输入；输入为空时回退到之前的消息",
	"Interrupt, or clear the input; twice to exit": "中断，或清空输入；连按两次退出",
	"Exit (input empty)": "退出（输入为空时）",
	"Cycle work mode: manual, auto, plan": "切换工作模式：手动确认、自动、规划",
	"Detailed view: tool output, thinking, time and model": "详细模式：完整的工具输出、思考过程、时间和模型",
	"Show or hide the task list": "显示或隐藏任务清单",
	"Switch model": "切换模型",
	"Cycle thinking level": "切换思考强度",
	"Search the input history": "搜索输入历史",
	"Redraw the screen": "重绘屏幕",
	"Edit the input in an external editor": "用外部编辑器编辑输入",
	"Send queued messages now": "立即发送排队的消息",
	"Restore queued messages": "取回排队的消息",
	"Queue a message until the reply ends": "排队到回复结束后再发",
	"Paste images, files or text": "粘贴图片、文件或文本",
	"Copy selection or the last reply": "复制选中内容或最后一条回复",
	"Suspend to background": "挂起到后台",
	"Next model": "下一个模型",
	"Previous model": "上一个模型",
	"Show or hide thinking": "显示或隐藏思考过程",
	"This list (input empty)": "显示本列表（输入为空时）",
	Commands: "命令",
	"Run a shell command": "运行 shell 命令",
	"Run a shell command (not sent to the model)": "运行 shell 命令（结果不发给模型）",
	"Move the cursor, or browse the history": "移动光标，或翻看输入历史",
	"Move the cursor": "移动光标",
	"Move by word": "按词移动",
	"Start of line": "到行首",
	"End of line": "到行尾",
	"Jump forward to character": "向后跳到某个字符",
	"Jump backward to character": "向前跳到某个字符",
	"Delete word backwards": "向前删除一个词",
	"Delete word forwards": "向后删除一个词",
	"Delete to start of line": "删除到行首",
	"Delete to end of line": "删除到行尾",
	"Paste the most-recently-deleted text": "粘贴刚删除的文字",
	"Cycle through the deleted text after pasting": "粘贴后轮换更早删除的文字",
	Undo: "撤销",
	"Complete a path or accept a suggestion": "补全路径或接受建议",
	"Scroll the conversation": "翻动对话",
	"Jump to your previous or next message": "跳到自己的上一条或下一条消息",
	"Search the conversation": "搜索对话",
	[MAC_OPTION_NOTE]:
		"Mac：Option 组合键要先在终端里打开“将 Option 键用作 Meta 键”。终端：设置 → 描述文件 → 键盘；iTerm2：Settings → Profiles → Keys → General，左右 Option 键都设为 Esc+。不做设置也可以用 Ctrl+J 或 \\ 加回车换行，用 /model 切换模型。",
	// The status lines of the detailed view and the work mode.
	"Detailed view: on": "详细模式：开（{key} 关闭）",
	"Detailed view: off": "详细模式：关",
	"Task list: shown": "任务清单：显示",
	"Task list: hidden": "任务清单：隐藏",
	"Context {percent}%": "上下文 {percent}%",
	"Work mode: {mode}": "工作模式：{mode}",
	"{mode} ({key} to switch)": "{mode}（{key} 切换）",
	manual: "手动确认",
	auto: "自动",
	bypass: "全部放行",
	plan: "规划模式",
	"No earlier input to search": "还没有可搜索的输入历史",
	"Search the input history (type to filter)": "搜索输入历史（输入文字筛选）",
	"{seconds}s": "{seconds} 秒",
	"{minutes}m {seconds}s": "{minutes} 分 {seconds} 秒",
	// Startup hints for the keys added on 2026-11-09.
	"to cycle work mode": "切换工作模式（手动确认、自动、规划）",
	"for the detailed view": "详细模式（完整的工具输出和思考过程）",
	"to show or hide the task list": "显示或隐藏任务清单",
	"to search the input history": "搜索输入历史",
	"for all shortcuts": "查看全部快捷键（输入为空时）",
	mode: "切换模式",
	shortcuts: "快捷键",
	// Resource sections at startup.
	Skills: "技能",
	Context: "上下文文件",
	Prompts: "提示模板",
	Extensions: "扩展",
};

/** Tool names users read: what each tool does, in Chinese; other languages keep the name. */
export const TOOL_LABELS_ZH: Readonly<Record<string, string>> = {
	read: "读取",
	write: "写入",
	edit: "修改",
	bash: "命令",
	powershell: "命令",
	grep: "查找内容",
	find: "查找文件",
	ls: "列出文件",
	search_web: "网络检索",
	fetch_web: "打开网页",
	material_add: "记录素材",
	word_count: "统计字数",
	readability_check: "可读性检查",
	style_check: "文风检查",
	export_document: "导出文档",
	import_document: "导入资料",
	topic_open: "打开专题",
	draft_restore: "恢复稿件",
	todo_write: "任务清单",
	ask_user: "提问",
	browser: "浏览器",
	computer: "桌面操作",
};

/** The name a tool is shown with. */
export function toolLabel(name: string): string {
	return currentLang() === "zh" ? (TOOL_LABELS_ZH[name] ?? name) : name;
}

/** text in the interface language: the Chinese entry of UI_ZH when the language is Chinese, else text; {name} filled from vars. */
export function uiText(text: string, vars: Readonly<Record<string, string>> = {}): string {
	// Chinese entry when there is one.
	const chosen = currentLang() === "zh" ? (UI_ZH[text] ?? text) : text;
	// Placeholders, then the product name of a release package.
	return brandText(chosen.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole));
}

/** The line of an interrupted reply, with the retries before it (2026-11-09: the screen showed "Operation aborted"). */
export function abortedText(retryAttempt: number): string {
	if (retryAttempt <= 0) return uiText("Operation aborted");
	const key = retryAttempt > 1 ? "Aborted after {count} retry attempts" : "Aborted after {count} retry attempt";
	return uiText(key, { count: String(retryAttempt) });
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
