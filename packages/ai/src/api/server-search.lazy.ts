/** Search and page reads by the upstream, loaded on first use: the SDKs stay out of startup. */

import type { ServerCall, ServerPage, ServerReport } from "./server-search.ts";

export type { ServerCall, ServerPage, ServerReport, ServerSource, ServerStyle, ServerWay } from "./server-search.ts";

/** Let the upstream search. */
export async function serverSearch(call: ServerCall, query: string): Promise<ServerReport> {
	return (await import("./server-search.ts")).serverSearch(call, query);
}

/** Let the upstream read a page. */
export async function serverFetch(call: ServerCall, url: string): Promise<ServerPage> {
	return (await import("./server-search.ts")).serverFetch(call, url);
}
