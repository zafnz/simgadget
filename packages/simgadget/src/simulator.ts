/**
 * The `Simulator` handle — SIMGADGET.md, "The `Simulator` handle".
 *
 * Step 2b (SIMGADGET_PLAN.md) adds the lifecycle and app methods: `boot()`,
 * `waitReady()`, `state()`, `shutdown()`, `delete()`, `installApp`,
 * `launchApp`, `restartBridge()`, `releaseCompanion()`. Everything about
 * reading the accessibility tree, orientation, tapping and capture arrives
 * in later steps (3 through 6); do not add methods here for those, extend
 * this class in the step that owns them instead.
 *
 * Every impure call goes through `this.deps` (`./internal/deps.ts`), never
 * `child_process` or a companion singleton directly — the fake-client test
 * layer depends on that seam being the only door to the outside world.
 */

import {
  BOOT_READY_TIMEOUT_MS,
  findDevice,
  isAlreadyBootedError,
  isInvalidDeviceError,
  restartSimulatorBridge,
  waitUntilDriveable,
  type ReadyResult,
  type SimulatorState,
} from "./lifecycle.ts";
import type { SimulatorDeps } from "./internal/deps.ts";
import { recoveryRegistry } from "./internal/registry.ts";
import { SimGadgetError, SimulatorNotFoundError } from "./errors.ts";
import { existsSync } from "fs";
import path from "path";

export class Simulator {
  readonly udid: string;
  readonly name: string;

  private _lastBoot?: ReadyResult;

  /**
   * Set by `delete()`. Every method below checks this first and throws
   * `SimulatorNotFoundError` before touching simctl or the companion — new
   * code, not a port: the repo-root server never kept a session's `SimSession`
   * around after `destroy_simulator`, so there was nothing to guard here
   * before this class existed. See SIMGADGET.md, "The `Simulator` handle":
   * "After delete(), or when something external deletes the simulator, every
   * method throws SimulatorNotFoundError."
   */
  private deleted = false;

  /** How the last boot/waitReady went; set by `createSimulator` (through
   * `boot()`), `boot()` and `waitReady()`. Undefined on a fresh attach. A
   * getter rather than a `readonly` field because the boot ladder finishes
   * long after the constructor has run, and a `readonly` field cannot be
   * assigned outside the constructor that declares it. */
  get lastBoot(): ReadyResult | undefined {
    return this._lastBoot;
  }

  /** @internal Everything on this class reaches the outside world through. */
  protected readonly deps: SimulatorDeps;

  /**
   * @internal Constructed only by `createSimulator`/`attachSimulator` in
   * `lifecycle.ts` (via `HandleFactory`), never directly by a library user —
   * `index.ts`'s exports make the class name resolvable but nothing stops a
   * caller from writing `new Simulator(...)` themselves, so this is a
   * documentation boundary, not an enforced one.
   */
  constructor(udid: string, name: string, deps: SimulatorDeps) {
    this.udid = udid;
    this.name = name;
    this.deps = deps;
  }

  /** The one writer for `_lastBoot`. Private: `boot()` and `waitReady()` are
   * the only things that produce a `ReadyResult`, and both live here now that
   * `boot()` owns the whole boot sequence — nothing outside this class has a
   * reason to write it, and an underscore-prefixed method would otherwise
   * ship on the published type. */
  private recordBoot(result: ReadyResult): void {
    this._lastBoot = result;
  }

  // ---- internal helpers ---------------------------------------------------

  /** The stale-handle check every method below runs before touching simctl
   * or the companion. */
  private assertNotDeleted(): void {
    if (this.deleted) throw new SimulatorNotFoundError(this.udid);
  }

  /** Maps simctl's "this udid doesn't exist" failure shape to
   * `SimulatorNotFoundError` (DECISIONS.md #13: "a clear error, never a gRPC
   * timeout"); every other failure passes through unchanged. Call inside a
   * catch, never on a value that is not already an error. */
  private mapSimctlError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (isInvalidDeviceError(message)) return new SimulatorNotFoundError(this.udid);
    return error instanceof Error ? error : new Error(message);
  }

  /** One `simctl` subcommand for this simulator, with `mapSimctlError`
   * applied to a failure. */
  private async runSimctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await this.deps.run("xcrun", ["simctl", ...args]);
    } catch (error) {
      throw this.mapSimctlError(error);
    }
  }

  // ---- lifecycle ------------------------------------------------------------

  /** Current simctl state. Cheap; hits `simctl list`. */
  async state(): Promise<SimulatorState> {
    this.assertNotDeleted();
    const device = await findDevice(this.deps, this.udid);
    if (!device) throw new SimulatorNotFoundError(this.udid);
    return device.state;
  }

  /**
   * Boots and waits until driveable — the whole sequence BOOT_BUG.md taught:
   * `simctl boot`, `open -a Simulator.app` (DECISIONS.md #1), then
   * `waitUntilDriveable`'s bootstatus wait, settle and poll. This method owns
   * the whole sequence; `createSimulatorWith` calls it rather than repeating
   * the steps and writing the result back into the handle afterwards.
   *
   * Does not throw on timeout — the simulator exists either way, and a throw
   * would discard the handle and the udid with it; inspect the result.
   * No-op boot (already booted) still performs the wait: `simctl boot` fails
   * "Unable to boot device in current state: Booted" for one, and that one
   * shape is swallowed so the wait still runs. Any other `simctl boot`
   * failure — a genuinely bad udid, a corrupted device — still propagates.
   */
  async boot(opts?: { budgetMs?: number }): Promise<ReadyResult> {
    this.assertNotDeleted();
    const budgetMs = opts?.budgetMs ?? BOOT_READY_TIMEOUT_MS;

    try {
      await this.runSimctl(["boot", this.udid]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isAlreadyBootedError(message)) throw error;
    }

    await this.deps.run("open", ["-a", "Simulator.app"]);

    const ready = await waitUntilDriveable(this.deps, this.udid, budgetMs);
    this.recordBoot(ready);
    return ready;
  }

  /** Waits (without booting) until an accessibility read answers with a real
   * frame. This is what the MCP's `attach_simulator` does after adopting.
   * Same ladder as `boot()`'s wait, so "costs nothing when already up" is as
   * true here as it is there: `simctl bootstatus` on an already-booted
   * device returns immediately. */
  async waitReady(opts?: { budgetMs?: number }): Promise<ReadyResult> {
    this.assertNotDeleted();
    const budgetMs = opts?.budgetMs ?? BOOT_READY_TIMEOUT_MS;
    const ready = await waitUntilDriveable(this.deps, this.udid, budgetMs);
    this.recordBoot(ready);
    return ready;
  }

  /** Tolerates an already-shut-down simulator, as today's cleanup does
   * (index.ts:481): a blanket swallow, not just the one shape `boot()`
   * matches, because there is nothing else useful to report from a shutdown
   * that "failed" only because there was nothing left to shut down. */
  async shutdown(): Promise<void> {
    this.assertNotDeleted();
    try {
      await this.deps.run("xcrun", ["simctl", "shutdown", this.udid]);
    } catch {
      // May already be shut down.
    }
  }

  /**
   * Shuts down and deletes the simulator. Ports `destroy_simulator`'s
   * sequence (index.ts:1337-1351):
   *
   * 1. `closeCompanion(udid)` — *before* any simctl call. `simctl
   *    shutdown`/`delete` takes seconds, and without the block a concurrent
   *    call for this simulator would see its companion channel die and
   *    spawn a replacement against a simulator that is about to stop
   *    existing (see `CompanionManager.close`'s header).
   * 2. `simctl shutdown`, tolerating "already shut down" the same way
   *    `shutdown()` does.
   * 3. `simctl delete` — not swallowed; a real failure here means the
   *    simulator was not actually deleted, so the handle must not be marked
   *    stale for it.
   * 4. Mark the handle stale and forget this udid's recovery state (today's
   *    `forgetSimulator`, index.ts:888).
   */
  async delete(): Promise<void> {
    this.assertNotDeleted();

    await this.deps.closeCompanion(this.udid);

    try {
      await this.deps.run("xcrun", ["simctl", "shutdown", this.udid]);
    } catch {
      // May already be shut down.
    }
    await this.runSimctl(["delete", this.udid]);

    this.deleted = true;
    recoveryRegistry.forget(this.udid);
  }

  // ---- apps -------------------------------------------------------------

  /** .app directory or .ipa. Throws `app-bundle-not-found` before calling
   * simctl if the path does not exist — simctl does not support `--` as an
   * option terminator, and this existsSync check is what makes passing a
   * caller-supplied path through safe. */
  async installApp(appPath: string): Promise<void> {
    this.assertNotDeleted();
    // DECISIONS.md #12: resolve with path.resolve() against the process cwd
    // and nothing more. `~/Downloads`-style behaviour is host policy.
    const absolutePath = path.resolve(appPath);

    if (!existsSync(absolutePath)) {
      throw new SimGadgetError(
        "app-bundle-not-found",
        `App bundle not found at: ${absolutePath}`
      );
    }

    await this.runSimctl(["install", this.udid, absolutePath]);
  }

  async launchApp(
    bundleId: string,
    opts?: { terminateRunning?: boolean }
  ): Promise<{ pid: number | null }> {
    this.assertNotDeleted();
    const { stdout } = await this.runSimctl([
      "launch",
      ...(opts?.terminateRunning ? ["--terminate-running-process"] : []),
      this.udid,
      bundleId,
    ]);

    // simctl launch outputs the PID as the first token in stdout; not every
    // invocation has one.
    const pidMatch = stdout.match(/^(\d+)/);
    return { pid: pidMatch ? Number(pidMatch[1]) : null };
  }

  // ---- low level — you should never need these ---------------------------

  /** Restarts the guest's CoreSimulator bridge (the wedge cure). Step 3's
   * recovery machinery calls `restartSimulatorBridge` (`./lifecycle.ts`)
   * itself, best-effort; this is the same command, public for a host that
   * wants to force it, with a real failure surfaced rather than swallowed. */
  async restartBridge(): Promise<void> {
    this.assertNotDeleted();
    try {
      await restartSimulatorBridge(this.deps, this.udid);
    } catch (error) {
      throw this.mapSimctlError(error);
    }
  }

  /** Stops this simulator's companion process. The exit hook
   * (`CompanionManager`'s `process.on("exit")`) does this anyway on process
   * exit; long-lived hosts get tidier teardown by calling it themselves. The
   * simulator itself keeps running, state intact. */
  async releaseCompanion(): Promise<void> {
    this.assertNotDeleted();
    await this.deps.shutdownCompanion(this.udid);
  }
}
