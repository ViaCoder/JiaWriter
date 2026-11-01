import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import toolSearchExtension from "./tool-search/index.ts";
// WriterAgent: the "wa" provider from WA_* environment variables.
import writerEnvExtension from "./writer-env/index.ts";

export const builtInExtensions: InlineExtension[] = [
	// WriterAgent: registers the WA_* model and clamps its output limit.
	{ name: "writer-env", factory: writerEnvExtension, builtin: true },
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
