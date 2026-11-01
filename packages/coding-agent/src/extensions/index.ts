import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import toolSearchExtension from "./tool-search/index.ts";
// WriterAgent: import_document, export_document and /import, /export.
import writerDocsExtension from "./writer-docs/index.ts";
// WriterAgent: the "wa" provider from WA_* environment variables.
import writerEnvExtension from "./writer-env/index.ts";
// WriterAgent: web_search and web_fetch (AnySearch or search_fetch in the user's Chrome).
import writerSearchExtension from "./writer-search/index.ts";
// WriterAgent: read-only writing checks (style_check, word_count, readability_check).
import writerToolsExtension from "./writer-tools/index.ts";

export const builtInExtensions: InlineExtension[] = [
	// WriterAgent: registers the WA_* model and clamps its output limit.
	{ name: "writer-env", factory: writerEnvExtension, builtin: true },
	// WriterAgent: the writing checks.
	{ name: "writer-tools", factory: writerToolsExtension, builtin: true },
	// WriterAgent: web search.
	{ name: "writer-search", factory: writerSearchExtension, builtin: true },
	// WriterAgent: reference import and draft export.
	{ name: "writer-docs", factory: writerDocsExtension, builtin: true },
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
