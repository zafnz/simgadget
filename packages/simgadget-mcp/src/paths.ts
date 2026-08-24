/**
 * Where a caller's file path actually lands.
 *
 * Thirty lines with a file to themselves for one reason: `~/` expansion and
 * the default-output-dir fallback are exactly the kind of rule that is wrong
 * in a way a type checker cannot see. Every argument is a `string` and every
 * result is a `string`, so the only thing that can catch "a bare filename went
 * to the process's working directory instead of `~/Downloads`" is a test — and
 * a test cannot reach it while it is inlined in a tool body that needs a
 * simulator to run.
 *
 * It is also the whole of the server's side of the file-path contract. The
 * library takes absolute paths only, deliberately: `screenshot({path})` and
 * `startRecording(path)` resolve nothing, because a library has no business
 * guessing at a home directory on its caller's behalf. So `screenshot` and
 * `record_video` run their arguments through here first, and what crosses into
 * `simgadget` is always already absolute.
 */

import os from "node:os";
import path from "node:path";
import { defaultOutputDir } from "./env.ts";

/**
 * Resolves a caller-supplied file path to an absolute one.
 *
 * The rules, in the order they are applied — a port of `ensureAbsolutePath`
 * (index.ts:2293), behaviour for behaviour:
 *
 *  1. An absolute path is returned untouched. The caller said exactly where.
 *  2. A path starting `~/` expands against the home directory. Shells do this
 *     before a program ever sees it; an MCP client does not, so a tilde
 *     arrives here literally and would otherwise create a directory named `~`.
 *  3. Anything else is relative, and joins the default output directory:
 *     `SIMGADGET_DEFAULT_OUTPUT_DIR` if set (itself `~/`-expanded, by the same
 *     rule), else `~/Downloads`.
 *
 * Note what rule 3 is *not*: it is not `path.resolve`, so a relative path never
 * lands in the server process's working directory. That directory belongs to
 * whoever launched the server — a daemon started from `/`, a client that
 * spawned it from its own project — and is never a place the caller meant.
 *
 * A bare `~` with nothing after it is not expanded, matching the original: it
 * is far more likely to be a filename than a home directory, and rule 3 puts
 * it somewhere findable either way.
 */
export function ensureAbsolutePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // Handle ~/something paths in the provided filePath
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  // Determine the default directory from env var or fallback to ~/Downloads
  let defaultDir = path.join(os.homedir(), "Downloads");
  const customDefaultDir = defaultOutputDir();

  if (customDefaultDir) {
    // also expand tilde for the custom directory path
    if (customDefaultDir.startsWith("~/")) {
      defaultDir = path.join(os.homedir(), customDefaultDir.slice(2));
    } else {
      defaultDir = customDefaultDir;
    }
  }

  // Join the relative filePath with the resolved default directory
  return path.join(defaultDir, filePath);
}
