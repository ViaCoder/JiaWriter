// Test-only native messaging host: what the writeragent binary does when Chrome starts it, run from
// source by Node (the launcher sets WA_DIR to the test's agent folder).
import { hostMain } from "../../../src/writer/browser/bridge.ts";

// Serve the extension until Chrome closes the pipe.
void hostMain(process.argv.slice(2), process.env.WA_DIR ?? "").then((code) => process.exit(code));
