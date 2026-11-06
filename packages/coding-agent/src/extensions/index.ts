import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import toolSearchExtension from "./tool-search/index.ts";
// JiaWriter: import_document, export_document and /import, /export.
import writerDocsExtension from "./writer-docs/index.ts";
// JiaWriter: the "jw" provider from JW_* environment variables.
import writerEnvExtension from "./writer-env/index.ts";
// JiaWriter: gongwen_check for the lieflat-gongwen skill (PolyForm Noncommercial, see its LICENSE).
import writerGongwenExtension from "./writer-gongwen/index.ts";
// JiaWriter: web_search and web_fetch (AnySearch or search_fetch in the user's Chrome).
import writerPromptsExtension from "./writer-prompts/index.ts";
// JiaWriter: read-only writing checks (style_check, word_count, readability_check).
// JiaWriter: going back in the conversation and the files.
import writerRewindExtension from "./writer-rewind/index.ts";
import writerSearchExtension from "./writer-search/index.ts";
// JiaWriter: built-in writing skills, /skills and /skill-new.
import writerSkillsExtension from "./writer-skills/index.ts";
import writerToolsExtension from "./writer-tools/index.ts";
// JiaWriter: topic folders, research archive and materials.
import writerTopicExtension from "./writer-topic/index.ts";
// JiaWriter: /lang and the /jw configuration page.
import writerUiExtension from "./writer-ui/index.ts";

export const builtInExtensions: InlineExtension[] = [
	// JiaWriter: registers the JW_* model and clamps its output limit.
	{ name: "writer-env", factory: writerEnvExtension, builtin: true },
	// JiaWriter: the writing checks.
	{ name: "writer-tools", factory: writerToolsExtension, builtin: true },
	// JiaWriter: the 公文 self-check.
	{ name: "writer-gongwen", factory: writerGongwenExtension, builtin: true },
	// JiaWriter: web search.
	{ name: "writer-prompts", factory: writerPromptsExtension, builtin: true },
	{ name: "writer-search", factory: writerSearchExtension, builtin: true },
	// JiaWriter: reference import and draft export.
	{ name: "writer-topic", factory: writerTopicExtension, builtin: true },
	{ name: "writer-docs", factory: writerDocsExtension, builtin: true },
	{ name: "writer-rewind", factory: writerRewindExtension, builtin: true },
	// JiaWriter: writing skills.
	{ name: "writer-skills", factory: writerSkillsExtension, builtin: true },
	// JiaWriter: interface language and configuration page.
	{ name: "writer-ui", factory: writerUiExtension, builtin: true },
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
