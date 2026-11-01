/**
 * Built-in WriterAgent extension: registers the "wa" provider built from WA_* variables
 * and keeps every request's output limit inside the context window.
 */

// Extension API types.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
// Output clamp and the provider name.
import { applyOutputClamp, WA_PROVIDER } from "../../writer/env-config.ts";
// State prepared by main.ts at startup.
import { getWriterModel } from "../../writer/writer-model.ts";

/** Extension factory. */
export default function writerEnvExtension(pi: ExtensionAPI): void {
	// Result of the startup step in main.ts.
	const state = getWriterModel();
	// Nothing to register unless WA_* produced a ready configuration.
	if (state.kind !== "ready") return;
	// Register the provider; its apiKey is the "$WA_KEY" reference, never the value.
	pi.registerProvider(WA_PROVIDER, state.provider);
	// Before each request, lower the output limit when the input leaves less room.
	pi.on("before_provider_request", (event, ctx) => {
		// Only requests to the WA_* model are adjusted.
		if (ctx.model?.provider !== WA_PROVIDER) return undefined;
		// A new payload, or undefined to keep the original one.
		return applyOutputClamp(event.payload, state.api, state.contextWindow, state.maxTokens);
	});
}
