#!/usr/bin/env node
import { setupCli } from "./cli/setup.ts";
import { getAgentDir } from "./config.ts";
import { main } from "./main.ts";
// JiaWriter: Chrome starts this program as the native messaging host of the browser extension.
import { hostMain, isHostArgv } from "./writer/browser/bridge.ts";
// JiaWriter: keys move from the environment into memory before anything else runs.
import { takeSecrets } from "./writer/secrets.ts";

// JiaWriter: JW_KEY and ANYSEARCH_KEY leave process.env here, so no child process inherits them.
takeSecrets();
const args = process.argv.slice(2);
if (isHostArgv(args)) {
	// JiaWriter: serve the extension until Chrome closes the pipe; no interface, nothing else on stdout.
	void hostMain(args, getAgentDir()).then((code) => process.exit(code));
} else {
	setupCli();
	main(args);
}
