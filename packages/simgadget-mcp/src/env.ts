/**
 * The server's eight configuration variables, and the
 * `IOS_SIMULATOR_MCP_*` → `SIMGADGET_*` rename.
 *
 * A near-copy of `simgadget/src/env.ts`, and deliberately so. The two packages
 * must read a shared name — `SIMGADGET_COMPANION_PATH` is the one that matters
 * — by exactly the same rule, and the alternative was exporting `readEnv` from
 * the library's public surface, where it would be a permanent API promise
 * about a five-line fallback. Thirty duplicated lines is the cheaper of the
 * two. If the rule ever changes, it changes in both files or it is a bug; the
 * shared behaviour is pinned by a test on each side.
 *
 * The split of variables is the split of responsibilities. The library owns
 * `COMPANION_PATH` and `COMPANION_CACHE_DIR` — facts about how a companion is
 * found — and this file owns the eight that are facts about *a server*:
 *
 *   ALLOWED_HOSTS  CLEANUP_ON_EXIT  DEFAULT_OUTPUT_DIR  FILTERED_TOOLS
 *   HTTP_HOST      HTTP_PORT        TRANSPORT           VERBOSE
 *
 * Each is read as `SIMGADGET_<name>` first, falling back to
 * `IOS_SIMULATOR_MCP_<name>` with exactly one stderr deprecation line per
 * variable per process. Per variable and not per read, because these are read
 * on every request in HTTP mode: a caller who set only the old name would
 * otherwise watch the same line scroll past hundreds of times, which teaches
 * an agent to ignore it rather than act on it.
 *
 * **Defaults live here, precedence does not.** Each accessor below returns the
 * documented default when neither spelling is set, so "what does an unset
 * TRANSPORT mean" has exactly one answer. The four that a CLI flag can also
 * override — transport, host, port, verbose — are combined with `parseArgs` in
 * `index.ts`, which is the only place that knows a command line exists.
 */

/**
 * The eight. A union rather than a bare `string` so a typo in a call is a
 * compile error rather than a variable that is silently never set — which is
 * the failure mode this whole file exists to make loud.
 */
export type ServerEnvName =
  | "ALLOWED_HOSTS"
  | "CLEANUP_ON_EXIT"
  | "DEFAULT_OUTPUT_DIR"
  | "FILTERED_TOOLS"
  | "HTTP_HOST"
  | "HTTP_PORT"
  | "TRANSPORT"
  | "VERBOSE";

/** Tracks which bare variable names have already logged their one warning. */
const warnedVariables = new Set<string>();

/**
 * Reads `SIMGADGET_<name>`, falling back to `IOS_SIMULATOR_MCP_<name>`.
 *
 * An empty string counts as unset on either name: `FOO=` in an environment
 * file is how a value gets cleared, not how the string `""` gets requested,
 * and treating it as "set" would make the new name un-overridable back to
 * nothing without unsetting it entirely.
 */
export function readEnv(name: ServerEnvName): string | undefined {
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
 * Truthiness as the old server spelled it (index.ts:2738): `1`, `true` or
 * `yes`, and nothing else. Note that this is *not* how `CLEANUP_ON_EXIT` is
 * read — that one defaults to on and only the literal string `false` turns it
 * off. The asymmetry is deliberate and predates the rename: an opt-in flag
 * should need a recognised yes, while a safety default should not be
 * switchable off by a typo.
 */
function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes"].includes((value ?? "").toLowerCase());
}

/**
 * Extra `host:port` pairs accepted in the HTTP transport's Host header, on top
 * of the loopback and container names `transport.ts` derives. Comma separated;
 * blank entries are dropped so a trailing comma is not a rejected host.
 */
export function allowedHosts(): string[] {
  const raw = readEnv("ALLOWED_HOSTS");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Whether simulators this server created are deleted when it exits. Default
 * on: leaving them behind is how a day's work silently accumulates orphaned
 * devices. Only the literal `false` turns it off, which is what
 * CLAUDE.md's development loop sets to keep a simulator across a restart.
 */
export function cleanupOnExit(): boolean {
  return (readEnv("CLEANUP_ON_EXIT") ?? "true").toLowerCase() !== "false";
}

/**
 * Where a relative screenshot or recording path lands. Returned raw — `~/`
 * expansion is `paths.ts`'s business, because the caller's own path needs the
 * identical treatment and one rule beats two.
 */
export function defaultOutputDir(): string | undefined {
  return readEnv("DEFAULT_OUTPUT_DIR");
}

/**
 * Tool names to leave unregistered. A filtered tool is genuinely absent from
 * `tools/list` rather than present-and-refusing, which is the whole point:
 * an agent cannot call what it cannot see.
 *
 * Entries are trimmed but *not* dropped when blank, matching the old server
 * exactly (index.ts:353). `FILTERED_TOOLS=""` is already unset by `readEnv`,
 * so the only way to produce an empty entry is a stray comma, and an empty
 * string matches no tool name anyway.
 */
export function filteredTools(): string[] {
  const raw = readEnv("FILTERED_TOOLS");
  if (!raw) return [];
  return raw.split(",").map((tool) => tool.trim());
}

/** Address the HTTP transport binds to. Loopback by default: this server hands
 * out control of a machine's simulators and has no authentication. */
export function httpHost(): string {
  return readEnv("HTTP_HOST") || "127.0.0.1";
}

/**
 * Port the HTTP transport binds to.
 *
 * A value that is not a number yields `NaN`, exactly as the old server's
 * `Number(...)` did. Deliberately not "fall back to 8008": a typo'd port that
 * silently binds the default is how two servers end up fighting over one port,
 * and `listen(NaN)` fails loudly at the one moment an operator is watching.
 */
export function httpPort(): number {
  return Number(readEnv("HTTP_PORT") || "8008");
}

/**
 * `http` or `stdio`, lowercased. HTTP is the default: sessions live in the
 * server process, so stdio — where every client spawns its own private server
 * — cannot share a simulator between agents, which is the point of this fork.
 */
export function transport(): string {
  return (readEnv("TRANSPORT") || "http").toLowerCase();
}

/** Whether to log connections and tool calls to stderr. */
export function verbose(): boolean {
  return truthy(readEnv("VERBOSE"));
}

/**
 * The `IDB_PATH` tombstone.
 *
 * `IOS_SIMULATOR_MCP_IDB_PATH` used to point at the Python `idb` CLI, which
 * this codebase stopped shelling out to in favour of gRPC directly. Its only
 * remaining behaviour is to explain that and throw — there is no value it
 * could hold that would do anything, so a `readEnv`-style deprecation shim
 * would be a bridge to a variable that has never worked and is not going to
 * start. Catches the new spelling too: `SIMGADGET_IDB_PATH` was never valid
 * either, and a caller who typed it deserves the same answer rather than
 * silent acceptance followed by an ordinary fallback warning.
 *
 * **Not called at module load**, which the old server did (index.ts:71). A
 * module that throws on import cannot be unit tested, and the thing being
 * protected is a *server run*, not an import: `index.ts` calls this at
 * startup, which fails just as loudly and only when it should.
 */
export function assertIdbPathUnset(): void {
  const next = process.env.SIMGADGET_IDB_PATH;
  const old = process.env.IOS_SIMULATOR_MCP_IDB_PATH;
  const value = next || old;
  if (!value) return;

  const name = next ? "SIMGADGET_IDB_PATH" : "IOS_SIMULATOR_MCP_IDB_PATH";
  throw new Error(
    `${name} is no longer supported: this server talks to idb_companion directly ` +
      `and never runs the \`idb\` CLI. Unset it, or use SIMGADGET_COMPANION_PATH ` +
      `to point at a specific idb_companion binary.`
  );
}

/**
 * Clears the once-per-process warning latch. Test-only, and the reason it is
 * exported at all: each test that asserts a fresh warning fires needs the
 * latch reset first. Nothing in `src/` calls it.
 */
export function resetEnvWarnings(): void {
  warnedVariables.clear();
}
