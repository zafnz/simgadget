#!/usr/bin/env node
/**
 * `simgadget prefetch`, and deliberately nothing else.
 *
 * The library has one thing worth doing from a shell: resolving the pinned
 * `idb_companion` ahead of time, so a CI image or a provisioning script pays
 * the ~19 MB download at a step where a slow step is expected rather than
 * inside the first test that touches a simulator. Everything else this package
 * does needs a running simulator and a program to decide what to do with it,
 * which is an API's job and not a command line's.
 *
 * **The path goes to stdout and the progress to stderr**, so
 * `COMPANION=$(npx simgadget prefetch)` is a working line of shell rather than
 * a path with a paragraph in front of it.
 *
 * Imports the resolver directly rather than through `./index.ts`: the public
 * entry pulls in the gRPC client and the whole handle, and none of it is
 * reachable from `prefetch`. A download should not cost a simulator's worth of
 * module loading.
 */

import { prefetchCompanion } from "./idb/companionBinary.ts";

const USAGE = `Usage: simgadget prefetch

Downloads and caches the pinned idb_companion, then prints its absolute path.
Progress is written to stderr; the path, alone, to stdout.

Environment:
  SIMGADGET_COMPANION_PATH   use this binary instead, and download nothing
  SIMGADGET_COMPANION_CACHE  where downloaded companions are cached`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "prefetch" && rest.length === 0) {
    const binary = await prefetchCompanion((message) => console.error(message));
    console.log(binary);
    return 0;
  }

  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }

  console.error(
    command === undefined
      ? `${USAGE}`
      : `Unknown command "${[command, ...rest].join(" ")}".\n\n${USAGE}`
  );
  return 2;
}

// No top-level await: this compiles to CommonJS, where there is none. The exit
// code is set rather than forced, so anything still buffered on stdout is
// written before the process leaves -- `process.exit` in a pipeline truncates
// exactly the path this command exists to print.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
);
