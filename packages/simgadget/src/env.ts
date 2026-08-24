/**
 * Configuration reads, and the `IOS_SIMULATOR_MCP_*` → `SIMGADGET_*` rename.
 *
 * SIMGADGET.md ("Configuration and the env rename") settles the shape: read
 * the new name, fall back to the old one with exactly one stderr line per
 * variable, drop the fallback two releases later. The "per variable, not per
 * read" part matters in practice — `readEnv` runs on every companion spawn and
 * every session start, and a caller who set only the old name would otherwise
 * see the same deprecation line scroll past dozens of times in one session,
 * which teaches an agent to ignore it rather than act on it.
 *
 * `simgadget-mcp` needs an identical reader for its eight server-side
 * variables, which is why this lives as a small standalone rule rather than a
 * couple of `??` fallbacks inlined at each of the library's two call sites.
 */

/** Tracks which bare variable names have already logged their one warning. */
const warnedVariables = new Set<string>();

/**
 * Reads `SIMGADGET_<name>`, falling back to `IOS_SIMULATOR_MCP_<name>`.
 *
 * `name` is the bare suffix shared by both spellings, e.g. `readEnv("COMPANION_PATH")`
 * reads `SIMGADGET_COMPANION_PATH` then `IOS_SIMULATOR_MCP_COMPANION_PATH`.
 *
 * An empty string counts as unset on either name: `FOO=` in an environment
 * file is how a value gets cleared, not how the string `""` gets requested,
 * and treating it as "set" would make the new name un-overridable back to
 * nothing without unsetting it entirely.
 */
export function readEnv(name: string): string | undefined {
  const newName = `SIMGADGET_${name}`;
  const newValue = process.env[newName];
  if (newValue) return newValue;

  const oldName = `IOS_SIMULATOR_MCP_${name}`;
  const oldValue = process.env[oldName];
  if (!oldValue) return undefined;

  if (!warnedVariables.has(name)) {
    warnedVariables.add(name);
    process.stderr.write(
      `[simgadget] ${oldName} is deprecated; use ${newName} instead. Support for ` +
        `the old name will be removed in a future release.\n`
    );
  }
  return oldValue;
}

/**
 * The `IDB_PATH` tombstone.
 *
 * `IOS_SIMULATOR_MCP_IDB_PATH` used to point at the Python `idb` CLI, which
 * this codebase stopped shelling out to in favour of gRPC directly. Its only
 * remaining behaviour is to explain that and throw — there is no value it
 * could hold that would do anything, so a `readEnv`-style deprecation shim
 * (read the new name, warn on the old) would be building a bridge to a
 * variable that has never worked and is not going to start. Better to say so
 * once, loudly, than to silently accept a value that is quietly ignored.
 *
 * Catches both spellings, including the new one: `SIMGADGET_IDB_PATH` was
 * never valid either, and a caller who typed it deserves the same answer, not
 * silent acceptance followed by `readEnv`'s ordinary fallback warning.
 *
 * Throws a plain `Error`, not a `SimGadgetError`: this reports a mistake in
 * the caller's own environment, not an operational failure with a `code` a
 * program is meant to branch on, and the frozen `ErrorCode` union has no slot
 * for it. Not called at module load — a library that throws on import merely
 * for being present in an environment is hostile to anyone who imports it for
 * an unrelated reason; it is called from companion resolution, where the
 * variable would actually matter.
 */
export function assertIdbPathUnset(): void {
  const next = process.env.SIMGADGET_IDB_PATH;
  const old = process.env.IOS_SIMULATOR_MCP_IDB_PATH;
  const value = next || old;
  if (!value) return;

  const name = next ? "SIMGADGET_IDB_PATH" : "IOS_SIMULATOR_MCP_IDB_PATH";
  throw new Error(
    `${name} is no longer supported: idb_companion is driven directly over gRPC, ` +
      `and no idb CLI is ever run. Unset it, or use SIMGADGET_COMPANION_PATH to ` +
      `point at a specific idb_companion binary.`
  );
}

/**
 * Clears the once-per-process warning latch. Test-only: it exists so each
 * test can assert a fresh warning fires, and is not part of the public
 * surface — `src/index.ts` does not re-export it, so it is unresolvable
 * outside this package the same way the fake `IdbClient` is.
 */
export function resetEnvWarnings(): void {
  warnedVariables.clear();
}
