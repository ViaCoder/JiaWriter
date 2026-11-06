/** Search and page reads by the upstream, loaded on first use: the SDKs stay out of startup. */

import type { ServerCall, ServerFresh, ServerPage, ServerPageOptions, ServerReport } from "./server-search.ts";

export type {
	ServerCall,
	ServerFresh,
	ServerPage,
	ServerPageOptions,
	ServerReport,
	ServerSource,
	ServerStyle,
	ServerWay,
} from "./server-search.ts";

/** Let the upstream search. */
export async function serverSearch(call: ServerCall, query: string, fresh?: ServerFresh): Promise<ServerReport> {
	return (await import("./server-search.ts")).serverSearch(call, query, fresh);
}

/** Let the upstream read a page. */
export async function serverFetch(call: ServerCall, url: string, options?: ServerPageOptions): Promise<ServerPage> {
	return (await import("./server-search.ts")).serverFetch(call, url, options);
}
