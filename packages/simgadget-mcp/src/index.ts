#!/usr/bin/env node
/**
 * The entry point: one registry, one server factory, one transport, one
 * shutdown.
 *
 * Everything here runs the moment this module is loaded, which is why there is
 * so little of it. Nothing in this file can be unit tested — an import starts a
 * server — so anything that could be got wrong quietly lives one file over:
 * `parseArgs` and `resolveConfig` in `transport.ts`, the defaults in `env.ts`,
 * the tools in `tools.ts`. What is left is the wiring, and the wiring is
 * checked by `test/mcp.test.mts`, which spawns this file built and asks it for
 * `tools/list`.
 *
 * ## The three things this file decides
 *
 * **One `SessionRegistry`, for the process.** In HTTP mode `createServer` is
 * called per request (see `runHttp`) and every one of those servers is handed
 * *this* registry — that is what makes a session outlive the connection that
 * created it, and it is why `registerTools` takes a registry as a parameter
 * rather than reaching for a module global.
 *
 * **The server's name is `simgadget`.** Clients display it, so it is a
 * behaviour change with a row of its own in SIMGADGET_PLAN_SERVER.md's
 * "Deliberate behaviour changes" (row 1), and `test/mcp.test.mts` allows it
 * against the captured baseline by naming that row.
 *
 * **Exit means cleanup.** `shutdown` is the one path that deletes simulators
 * this server created, and it runs at most once however many ways it is
 * reached — a SIGINT while a SIGTERM's cleanup is in flight must not start a
 * second pass over the same handles.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import path from "node:path";

import { attachSimulator, createSimulator } from "simgadget";

import { assertIdbPathUnset } from "./env.ts";
import { SessionRegistry } from "./sessions.ts";
import { registerTools, SERVER_INSTRUCTIONS } from "./tools.ts";
import { toError } from "./render.ts";
import {
  createVlog,
  parseArgs,
  resolveConfig,
  runHttp,
  runStdio,
} from "./transport.ts";

/**
 * The version clients see in `serverInfo`.
 *
 * Read from the package's own `package.json` rather than baked in at build
 * time, so a published tarball reports the version it was published as and
 * nothing has to be kept in sync by hand. `__dirname` is `build/`, which makes
 * this `packages/simgadget-mcp/package.json` in the repo and the installed
 * package's own manifest once published — npm always includes it, whatever
 * `files` says.
 */
const PACKAGE_VERSION: string = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
).version;

const config = resolveConfig(parseArgs(process.argv.slice(2)));
const vlog = createVlog(config.verbose);

/**
 * Every session this process owns. One registry, deliberately: see the header.
 *
 * The constructors are wrapped rather than defaulted so every handle gets
 * `onLog: vlog`. The wedge recovery is the one thing in the library that acts
 * on its own — it restarts a service inside the guest and retries the caller's
 * read — and after the port it did so in silence, which cost TESTING_SERVER.md
 * its only observable for that behaviour (TODO #100). The library stays silent
 * by default, as a library should; the server is the caller that asks.
 */
const sessions = new SessionRegistry({
  create: (opts) => createSimulator({ ...opts, onLog: vlog }),
  attach: (udid) => attachSimulator(udid, { onLog: vlog }),
});

/**
 * Builds a server carrying the full tool surface over the shared registry.
 *
 * Called once in stdio mode and once per request in HTTP mode. Note what is
 * *not* passed: no explicit `capabilities`, because `server.tool()` declares
 * the tools capability itself and the captured baseline was taken from a server
 * that passed none.
 */
function createServer(): McpServer {
  const server = new McpServer(
    { name: "simgadget", version: PACKAGE_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );
  registerTools(server, sessions);
  return server;
}

async function runServer(): Promise<void> {
  // Before anything is bound or connected: a set IDB_PATH means the operator
  // believes this server shells out to the Python `idb` CLI, and every
  // conclusion they draw from that is wrong. It has to fail at startup rather
  // than be discovered on the first tool call — see `assertIdbPathUnset`.
  assertIdbPathUnset();

  if (config.transport === "http") {
    await runHttp({
      createServer,
      host: config.host,
      port: config.port,
      verbose: config.verbose,
      vlog,
    });
  } else {
    await runStdio({ createServer, onStdinClose: shutdown });
  }
}

/**
 * Shuts down at most once: stop the recordings, delete what we created, let go
 * of what we merely borrowed. All of it is `SessionRegistry.shutdown`'s, which
 * is where the ownership rules live and where they are tested.
 *
 * The old server also called `companions.shutdownAll()` (index.ts:3025); that
 * is library-internal now and unreachable from here. Its public equivalent is
 * `releaseCompanion()` per handle, which the registry's shutdown already does
 * for every session it does not delete — and `CompanionManager` installs its
 * own exit hook, which covers the paths that never reach this function.
 */
let cleaningUp = false;
async function shutdown(): Promise<void> {
  if (cleaningUp) return;
  cleaningUp = true;
  try {
    await sessions.shutdown();
  } catch {
    // Exit is not the moment to fail: whatever could be cleaned up, was.
  }
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

// A failure to start is fatal and must say so in the exit code. The old server
// logged and let the process fall off the end of the event loop, which in HTTP
// mode meant a configuration error exited 0 — indistinguishable from a clean
// stop to anything supervising it.
runServer().catch((error) => {
  console.error(toError(error).message);
  process.exit(1);
});
