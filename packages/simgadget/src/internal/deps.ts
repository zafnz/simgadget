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
import { recoveryRegistry, type RecoveryRegistry } from "./registry.ts";

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
  /**
   * A timer that can be called off, returning its own cancel function.
   *
   * Distinct from `sleep` because the two want opposite things from an
   * abandoned wait. `sleep` is a wait the library intends to sit through — the
   * rotation settle, the boot poll — and holding the event loop open is the
   * point of it. This is a *fallback* that usually loses its race, and a
   * fallback nobody cancels is a defect in a library even though it was
   * invisible in a server: a pending `setTimeout` keeps Node alive, so
   * `waitForRecordingStart`'s 3s "alive but silent, assume it started" timer
   * added a silent three-second tail to the exit of every script that recorded
   * anything (measured: 3001ms). The server never noticed because it outlived
   * the timer by hours. The three-line script this library exists to serve does
   * not.
   *
   * Cancelling an already-fired timer is a no-op, so callers may cancel freely.
   */
  setTimer(ms: number, fn: () => void): () => void;
  /** Milliseconds since the epoch. `Date.now()` in production; a fake clock
   * in tests, so the recovery cooldown and the rotation settle can be
   * measured without waiting them out. */
  now(): number;
  /**
   * Stops `udid`'s companion and refuses to start another until
   * `reopenCompanion`. Delegates to `CompanionManager.close`; see that
   * method's comment for why `Simulator.delete()` needs the block held
   * across its `simctl shutdown`/`delete` calls rather than just stopping
   * the companion. On the deps seam (DECISIONS.md #19) rather than reached
   * directly, so a test can assert `delete()` calls this *before* any simctl
   * call — the whole reason the fake keeps an ordered call log.
   */
  closeCompanion(udid: string): Promise<void>;
  /** Allows companions for `udid` again after `closeCompanion`. Delegates to
   * `CompanionManager.reopen`. */
  reopenCompanion(udid: string): void;
  /** Stops whatever companion is currently running for `udid`, if any.
   * Delegates to `CompanionManager.shutdown`. This is `releaseCompanion()`'s
   * tidy path. */
  shutdownCompanion(udid: string): Promise<void>;
  /**
   * The udid-keyed recovery state — has this simulator ever answered, when was
   * its bridge last restarted, is a restart in flight.
   *
   * On the seam rather than imported as the singleton (DECISIONS.md #21): the
   * process-level `recoveryRegistry` is right for production, where two handles
   * on one udid must share one recovery attempt, and wrong for tests, where one
   * case's `markAnswered` would leak into the next and quietly decide whether
   * recovery is eligible at all. The fake supplies a fresh registry per test,
   * exactly the way it supplies a fake clock.
   */
  recovery: RecoveryRegistry;
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
  setTimer(ms, fn) {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
  now: () => Date.now(),
  closeCompanion: (udid) => companions.close(udid),
  reopenCompanion: (udid) => companions.reopen(udid),
  shutdownCompanion: (udid) => companions.shutdown(udid),
  recovery: recoveryRegistry,
};
