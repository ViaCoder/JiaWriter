#!/usr/bin/env node
import { setupCli } from "./cli/setup.ts";
import { getAgentDir } from "./config.ts";
import { main } from "./main.ts";
// WriterAgent: Chrome starts this program as the native messaging host of the browser extension.
import { hostMain, isHostArgv } from "./writer/browser/bridge.ts";

const args = process.argv.slice(2);
if (isHostArgv(args)) {
	// WriterAgent: serve the extension until Chrome closes the pipe; no interface, nothing else on stdout.
	void hostMain(args, getAgentDir()).then((code) => process.exit(code));
} else {
	setupCli();
	main(args);
}
