/**
 * The parts both e2e files need before they can touch a simulator: whether this
 * machine can run them at all, which `idb_companion` to use, where the fixture
 * app is, and how to get rid of a simulator that a failing test left behind.
 *
 * Not named `*.e2e.mts`, so `node --test "test/e2e/*.e2e.mts"` does not try to
 * run it as a test file. It is a library for the two that are.
 *
 * **Nothing here touches a simulator it did not create.** The two suites create
 * their own, name them `simgadget-e2e-*`, and delete them in `after()`
 * including on failure; `deleteQuietly` below is the backstop for the case
 * where the handle itself is too broken to do it.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `packages/simgadget/test/e2e/` → the repository root. */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);

export const FIXTURE_APP = path.join(REPO_ROOT, "testapp/build/MCPTestApp.app");
export const FIXTURE_BUNDLE_ID = "com.example.mcptestapp";

/**
 * Why this run cannot happen, or `false` when it can.
 *
 * A `describe(..., { skip })` rather than a failure: a suite that needs Xcode
 * and a simulator has nothing useful to say on a machine without them, and
 * saying so by name beats a stack trace out of `xcrun`.
 */
export function unavailable(): string | false {
  if (process.platform !== "darwin") {
    return `iOS simulators only exist on macOS (this is ${process.platform})`;
  }
  try {
    // Synchronous on purpose: this answer is needed while the module is still
    // being evaluated, before `describe` decides whether to skip.
    execFileSync("xcrun", ["-f", "simctl"], { stdio: "ignore" });
  } catch {
    return "xcrun simctl is not on this machine — install Xcode and its command line tools";
  }
  return false;
}

/**
 * Points `SIMGADGET_COMPANION_PATH` at a companion this machine already has,
 * unless the caller has already chosen one.
 *
 * The cache directory was renamed from `ios-multi-simulator-mcp` to
 * `simgadget` this phase (SIMGADGET_PLAN.md step 1.5), which orphaned a 19 MB
 * download that is otherwise still exactly the right binary. Re-fetching it to
 * run the tests would be a slow, network-dependent first run for no gain, so
 * the old location is checked before falling through to `resolveCompanion`'s
 * ordinary download.
 *
 * Read lazily by `companionBinary.ts` on every spawn, so setting it here — long
 * after the imports have run — is in time.
 */
export function useCachedCompanion(): void {
  if (process.env.SIMGADGET_COMPANION_PATH) return;

  const legacyCache = path.join(
    process.env.HOME ?? "",
    "Library/Caches/ios-multi-simulator-mcp/companion"
  );
  if (!existsSync(legacyCache)) return;

  for (const entry of readdirSync(legacyCache)) {
    const candidate = path.join(legacyCache, entry, "idb_companion");
    if (existsSync(candidate)) {
      process.env.SIMGADGET_COMPANION_PATH = candidate;
      return;
    }
  }
}

/**
 * Builds `testapp/` when it is missing **or older than its source**, so the
 * suite runs from a clean checkout and never from a stale bundle.
 *
 * The staleness half is the part that was missing, and its absence cost two
 * confusing runs: edit `main.m`, rerun, and the old bundle is silently tested
 * instead. What that looks like is not "the fixture is stale" — it is geometry
 * assertions failing against source that plainly says otherwise, which reads as
 * a library bug. The two cases most likely to be under edit are the two that
 * depend on where controls sit (see the toolbar helpers below), so this is
 * precisely the wrong place to guess.
 *
 * mtime, not a content hash: the question is only whether the build ran after
 * the last edit, `build.sh` is the sole writer of the bundle, and a hash would
 * have to cover the whole source tree to say anything a timestamp does not.
 */
export async function ensureFixtureBuilt(): Promise<void> {
  if (existsSync(FIXTURE_APP) && !fixtureIsStale()) return;
  await execFileAsync(path.join(REPO_ROOT, "testapp/build.sh"), [], {
    cwd: REPO_ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * True when any fixture source is newer than the built binary.
 *
 * The binary rather than the `.app` directory: a bundle directory's mtime moves
 * when anything inside it is touched, including a re-signing that changed
 * nothing, so it is not evidence that a compile happened.
 *
 * A missing binary counts as stale — an `.app` that exists without one is a
 * half-written build, and rebuilding is the right answer either way.
 */
function fixtureIsStale(): boolean {
  const built = path.join(FIXTURE_APP, "MCPTestApp");
  if (!existsSync(built)) return true;
  const builtAt = statSync(built).mtimeMs;
  return FIXTURE_SOURCES.some((source) => {
    const full = path.join(REPO_ROOT, source);
    return existsSync(full) && statSync(full).mtimeMs > builtAt;
  });
}

/** Everything `build.sh` compiles or embeds. A source added here and not listed
 * is a fixture edit the suite can silently miss, which is the whole bug. */
const FIXTURE_SOURCES = [
  "testapp/main.m",
  "testapp/Info.plist",
  "testapp/entitlements.plist",
  "testapp/build.sh",
];

/**
 * Deletes a simulator by udid, swallowing everything.
 *
 * The backstop for `after()`: `Simulator.delete()` is the proper route and is
 * tried first, but a test that failed halfway through can leave a handle that
 * refuses to do anything, and a leaked simulator costs a gigabyte and outlives
 * the run. Shutdown first because a delete of a booted device is slower and
 * noisier, and both are ignored because "it was already gone" is a success
 * here.
 */
export async function deleteQuietly(udid: string): Promise<void> {
  for (const verb of ["shutdown", "delete"]) {
    try {
      await execFileAsync("xcrun", ["simctl", verb, udid]);
    } catch {
      // Already shut down, already deleted, or never existed.
    }
  }
}

/** Every simulator simctl currently knows about, as `{udid, name, state}`. The
 * suites' own check on the library rather than a use of it: `listSimulators()`
 * is one of the things under test, so what it is compared against has to come
 * from somewhere else. */
export async function simctlDevices(): Promise<
  { udid: string; name: string; state: string }[]
> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "-j"], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { devices?: Record<string, unknown> };
  return Object.values(parsed.devices ?? {})
    .filter(Array.isArray)
    .flat() as { udid: string; name: string; state: string }[];
}

/**
 * Waits for something the *simulator* does on its own schedule — an app coming
 * to the foreground, the home-screen animation finishing.
 *
 * **Never wrap the behaviour under test in this.** A retry around the thing
 * being measured is precisely how a tap that lands eleven times in twelve gets
 * shipped (SIMGADGET_PLAN.md, "Risks": e2e flakiness is a real signal). This
 * exists so that the *setup* for an assertion can be waited for
 * instead of guessed at with a sleep, and it throws rather than continuing when
 * the wait does not come good, so a silent near-miss stays impossible.
 */
export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** `waitFor`'s negative twin: waits for something to stop being true. */
export async function waitUntilGone(
  what: string,
  probe: () => Promise<unknown>,
  timeoutMs = 15_000
): Promise<void> {
  await waitFor(what, async () => ((await probe()) ? false : true), timeoutMs);
}
