/**
 * The injectable seam between the library's logic and everything that talks
 * to a real simulator, a real process, or the real clock.
 *
 * Every `Simulator` method and lifecycle function reaches the outside world
 * through a `SimulatorDeps`, never importing `companionManager`,
 * `child_process` or `Date.now` for itself. That is what lets the
 * fake-client unit test layer (SIMGADGET_PLAN.md's three-layer model) drive
 * the whole public API against `test/fakes/` — no simulator, no companion —
 * and, the part a fake `IdbClient` alone can't buy: no waiting out real
 * time either. `sleep` stands in for the 1.5s rotation settle and the 60s
 * recovery cooldown; `now()` stands in for the clock those cooldowns are
 * measured against. A test that had to `setTimeout(60_000)` to prove the
 * cooldown suppresses a second recovery attempt would be sixty seconds
 * proving what a fake clock proves in a millisecond.
 *
 * `withClient` delegates to the process-level singleton `companions` in
 * `../idb/companionManager.ts` rather than constructing a `CompanionManager`
 * of its own — that file's header explains why a second instance would spawn
 * and leak a second companion per simulator. `run` and `spawn` are the two
 * escapes to the OS this package needs beyond gRPC: `run` for one-shot
 * `simctl`/`sips` calls, `spawn` for `simctl io ... recordVideo`, which is a
 * long-lived process rather than a call and has no gRPC equivalent to wrap.
 *
 * Internal only. Not exported from `../index.ts`, and unresolvable to a user
 * of the published package regardless — the `exports` map in `package.json`
 * exposes only the package root.
 */

import { ChildProcess, execFile, spawn } from "child_process";
import { promisify } from "util";
import { IdbClient } from "../idb/client.ts";
import { companions, type WithClientOptions } from "../idb/companionManager.ts";

const execFileAsync = promisify(execFile);

export interface SimulatorDeps {
  /**
   * Runs `fn` against a live idb_companion for `udid`, spawning one if
   * needed. See `CompanionManager.withClient` for what "live" absorbs
   * (respawn-on-dead-channel for reads, no retry for exclusive calls, since
   * input events are not idempotent).
   */
  withClient<T>(
    udid: string,
    fn: (client: IdbClient) => Promise<T>,
    options?: WithClientOptions
  ): Promise<T>;
  /**
   * A one-shot command, e.g. `simctl`, `sips`. Verbatim behaviour of the
   * repo-root `src/index.ts`'s `run()`: `execFile` via `promisify`,
   * `shell: false` so a caller-supplied argument is passed as data rather
   * than parsed as shell syntax, stdout/stderr trimmed.
   */
  run(
    cmd: string,
    args: string[]
  ): Promise<{ stdout: string; stderr: string }>;
  /**
   * A long-lived child process. Exists for `simctl io ... recordVideo`:
   * recording keeps running until stopped, so it cannot go through `run`,
   * which waits for the process to exit before resolving.
   */
  spawn(cmd: string, args: string[]): ChildProcess;
  sleep(ms: number): Promise<void>;
  /** Milliseconds since the epoch. `Date.now()` in production; a fake clock
   * in tests, so the recovery cooldown and the rotation settle can be
   * measured without waiting them out. */
  now(): number;
}

export const realDeps: SimulatorDeps = {
  withClient: (udid, fn, options) => companions.withClient(udid, fn, options),
  async run(cmd, args) {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      shell: false,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  },
  spawn: (cmd, args) => spawn(cmd, args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};
