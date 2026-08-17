/**
 * The `Simulator` handle — SIMGADGET.md, "The `Simulator` handle".
 *
 * Step 2b (SIMGADGET_PLAN.md) added the lifecycle and app methods: `boot()`,
 * `waitReady()`, `state()`, `shutdown()`, `delete()`, `installApp`,
 * `launchApp`, `restartBridge()`, `releaseCompanion()`. Step 3 adds the
 * reading half — `describeScreen()`, `screenSize()`, `findByLabel()`,
 * `findByIdentifier()`, `describePoint()` — and the wedge-recovery machinery
 * underneath all of them. Orientation, acting and capture arrive in steps 4
 * through 6; do not add methods here for those, extend this class in the step
 * that owns them instead.
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
import {
  AccessibilityUnreadableError,
  SimGadgetError,
  SimulatorNotAnsweringError,
  SimulatorNotFoundError,
} from "./errors.ts";
// `ax/tree.ts`'s `AXElement` is the internal, open type; the closed public one
// lands in plan step 8, when `canonicalise` becomes the conversion point
// (DECISIONS.md #4).
import {
  DESCRIBE_KEYS,
  POINT_KEYS,
  canonicalise,
  isDegenerateTree,
  isRemotelyHosted,
  locateInTree,
  matchInTree,
  pruneTree,
  reconcileType,
  translateRemoteSubtrees,
  type AXElement,
  type Frame,
} from "./ax/tree.ts";
import { isNoElementError, isWedgeError, shouldRecover } from "./ax/recovery.ts";
import { Backend, Format, SearchableKey } from "./idb/client.ts";
import { existsSync } from "fs";
import path from "path";

export interface ScreenRead {
  /** Pruned tree; `elements[0]` is the screen root carrying the full frame. */
  elements: AXElement[];
  /** Logical dimensions from that root frame — the space every coordinate in
   * `elements`, and every coordinate handed back in, lives in. */
  screen: { width: number; height: number };
}

// ---- Recovery constants ----------------------------------------------------
//
// Ported from index.ts:827-855 with their comments, which are the evidence:
// every one of these was measured against a real wedged bridge, and the
// obvious value is wrong for a reason that is invisible until it bites.

/**
 * How long to keep asking a restarted bridge whether it is back.
 *
 * Poll rather than settle-and-check, because the settle time is not knowable.
 * Measured on a deliberately stopped bridge: `simctl spawn ... launchctl stop`
 * took ~5s to return, and the device answered ~11s after the restart was
 * ordered. A single probe at 4s — what this did first — declared the recovery
 * failed on a simulator that was serving reads 1.6s later, which is the worst
 * possible answer: the cure worked and the caller was told it had not.
 */
const RECOVERY_PROBE_TIMEOUT_MS = 20_000;

/** How often to ask, inside that window. */
const RECOVERY_PROBE_INTERVAL_MS = 1_000;

/**
 * Attempts at the caller's read once the bridge is answering again.
 *
 * More than one because a bridge answers the recovery probe slightly before it
 * answers reliably: measured on a restarted bridge, the probe succeeded, the
 * read immediately after it failed with the same wedge error, and the next call
 * 21ms later succeeded. Handing back a failure the cure had already fixed is
 * the one outcome worth spending an extra second to avoid.
 */
const POST_RECOVERY_READ_ATTEMPTS = 3;

/** Pause between those attempts. */
const POST_RECOVERY_READ_DELAY_MS = 500;

/**
 * Shortest interval between two recovery attempts for one simulator.
 *
 * A wedged simulator being driven by an agent produces a failed read every few
 * hundred milliseconds, and restarting the bridge under each one would leave it
 * permanently mid-restart. Once the cure has been tried and the reads are still
 * failing, the cause is something a restart does not fix, and the caller is
 * better served by the error than by another minute of retries.
 */
const RECOVERY_COOLDOWN_MS = 60_000;

/**
 * Point-read probes in the empty-tree diagnosis.
 *
 * A point read has a warm-up quirk: the first call after boot can return an
 * empty 0x0 element even on a booted simulator, and subsequent calls succeed.
 * One probe would therefore call a booted-but-wedged device "still booting".
 */
const DIAGNOSTIC_POINT_PROBES = 3;

/** Where the diagnosis probes. Any point on screen answers on a live bridge;
 * this one is inside the status bar on every device this library supports. */
const DIAGNOSTIC_POINT = { x: 100, y: 100 };

/** Ports index.ts:691 — the companion's rejections are not always `Error`s. */
function toError(input: unknown): Error {
  if (input instanceof Error) return input;
  if (
    typeof input === "object" &&
    input &&
    "message" in input &&
    typeof input.message === "string"
  )
    return new Error(input.message);
  return new Error(JSON.stringify(input));
}

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

  /**
   * The *logical* screen dimensions from the most recent describe's root
   * frame — the port of today's `SimSession.screenDims` (index.ts:364), and
   * per-handle by DECISIONS.md #5. Written only by `noteRootFrame`; read by
   * step 4's `toPortrait` and step 5's tap geometry, and invalidated there by
   * `rotate()` and `detectOrientation()`. Nothing in step 3 reads it, which is
   * why it is `protected` rather than private: it is state this class holds on
   * behalf of the steps that extend it.
   */
  protected screenDims: { width: number; height: number } | null = null;

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
    this.deps.recovery.forget(this.udid);
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

  // ---- reading: the two funnels later steps hang off ----------------------

  /**
   * Logical → portrait coordinates, the space the companion's point reads and
   * touches accept.
   *
   * **The identity, deliberately, until step 4** (DECISIONS.md #22): the
   * transform needs the orientation hint, which step 4 owns. That is correct
   * rather than merely incomplete for a portrait device — which is every
   * simulator until something rotates it — and it keeps step 4's job to one
   * call site instead of five.
   */
  private toPortrait(x: number, y: number): { x: number; y: number } {
    return { x, y };
  }

  /**
   * The one place a describe's root frame is recorded. Step 3 caches the
   * logical screen dimensions here; step 4 additionally reconciles the
   * orientation hint against the frame's aspect (DECISIONS.md #8 and #22), so
   * every describe that yields a root frame already goes through this single
   * call site rather than needing five of them found later.
   *
   * A zero-sized frame is not recorded: a booting simulator answers with one,
   * and caching it would hand every later coordinate transform a screen with
   * no size.
   */
  private noteRootFrame(frame: Frame): void {
    if (frame.width && frame.height) {
      this.screenDims = { width: frame.width, height: frame.height };
    }
  }

  // ---- reading: recovery --------------------------------------------------

  /**
   * Records that this simulator served a *usable* read.
   *
   * Deliberately not "the call did not throw": a simulator that is still
   * booting answers with a 0x0 root frame rather than an error, and treating
   * that as proof of a working bridge would arm recovery against every device
   * that is merely slow — the boot ladder's job, with its own budget.
   */
  private markAnswered(): void {
    this.deps.recovery.markAnswered(this.udid);
  }

  /** Milliseconds since this simulator's bridge was last restarted. */
  private msSinceRecovery(): number {
    const last = this.deps.recovery.lastRecoveryAt(this.udid);
    return last === undefined ? Number.POSITIVE_INFINITY : this.deps.now() - last;
  }

  /**
   * Whether the simulator's accessibility service is answering at all.
   *
   * A whole-screen read rather than a point read, because a point read cannot
   * answer this question: idb raises the *same* `no translation object` error
   * for a dead bridge and for a point with nothing on it. Asking for the screen
   * has no such ambiguity — a bridge that is up returns a tree.
   *
   * Never triggers recovery, being what recovery uses to judge itself, so it
   * cannot recurse into the code that calls it.
   */
  private async accessibilityIsAnswering(): Promise<boolean> {
    try {
      const frame = await this.deps.withClient(this.udid, async (client) => {
        const info = (await client.accessibilityInfo({
          format: Format.NESTED,
        })) as AXElement[] | AXElement | null;
        if (info == null) return null;
        const root = Array.isArray(info) ? info[0] : info;
        return root?.frame ?? null;
      });
      return !!frame && !!(frame.width && frame.height);
    } catch {
      return false;
    }
  }

  /**
   * Whether a *point* read answers, which is a different question.
   *
   * Used only to tell a simulator that is still booting from one whose tree has
   * gone empty: the second answers point queries while returning nothing for
   * the screen, and the first answers neither.
   */
  private async accessibilityPointAnswers(): Promise<boolean> {
    try {
      const element = (await this.deps.withClient(this.udid, (client) =>
        client.accessibilityInfo({
          point: DIAGNOSTIC_POINT,
          format: Format.LEGACY,
          keys: DESCRIBE_KEYS,
        })
      )) as AXElement | null;
      return !!element?.frame && !!(element.frame.width || element.frame.height);
    } catch {
      return false;
    }
  }

  /**
   * Restarts the wedged bridge and reports whether the simulator answers again.
   *
   * Deduplicated and rate-limited per *simulator*, not per handle — several
   * reads failing at once is what a wedge looks like from the outside, and they
   * share a single restart rather than each ordering their own. That is the
   * whole reason the state lives in a udid-keyed registry (SIMGADGET.md's
   * Decisions register).
   */
  private async recoverWedgedAccessibility(): Promise<boolean> {
    const inFlight = this.deps.recovery.recoveryInFlight(this.udid);
    if (inFlight) return inFlight;

    if (this.msSinceRecovery() < RECOVERY_COOLDOWN_MS) return false;

    const attempt = (async () => {
      try {
        await restartSimulatorBridge(this.deps, this.udid);
      } catch {
        return false;
      }
      const deadline = this.deps.now() + RECOVERY_PROBE_TIMEOUT_MS;
      let recovered = false;
      do {
        await this.deps.sleep(RECOVERY_PROBE_INTERVAL_MS);
        recovered = await this.accessibilityIsAnswering();
      } while (!recovered && this.deps.now() < deadline);
      return recovered;
    })();

    this.deps.recovery.setLastRecoveryAt(this.udid, this.deps.now());
    this.deps.recovery.setRecoveryInFlight(this.udid, attempt);
    try {
      return await attempt;
    } finally {
      this.deps.recovery.setRecoveryInFlight(this.udid, undefined);
      // Time the cooldown from when the attempt finished, not from when it
      // started, so the ~5s restart itself is not counted against it.
      this.deps.recovery.setLastRecoveryAt(this.udid, this.deps.now());
    }
  }

  /**
   * Runs an accessibility read, curing a wedged bridge underneath it.
   *
   * The wedge — a simulator that renders, taps and answers `describe` while
   * every accessibility read fails forever — is cured by restarting the guest's
   * bridge (BOOT_BUG.md). Wrapping the reads themselves rather than the verbs
   * built on them means every method is recovered by the same code and none of
   * them has to know.
   *
   * Only for a simulator that has answered before, and only for the one error a
   * restart cures — see `shouldRecover` for why both gates matter. Cure once,
   * then a handful of attempts at the caller's read; a wedge that outlives that
   * is reported rather than retried around.
   *
   * Giving up throws `SimulatorNotAnsweringError`, never idb's own wording:
   * design rule 2, so no caller ever regexes a message. A failure that is *not*
   * the wedge is the caller's real answer and passes through untouched — which
   * is what lets `findByLabel` recognise "found no element" and `describePoint`
   * disambiguate an empty point, both of which run inside this wrapper.
   */
  private async withAccessibilityRecovery<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      const message = toError(error).message;
      // Not the wedge: a bad argument, a dead companion, a deleted simulator.
      // None of those is cured by restarting a service, and the caller wants
      // the real failure.
      if (!isWedgeError(message)) throw error;

      const answered = this.deps.recovery.hasAnswered(this.udid);
      const decided = shouldRecover({
        answered,
        message,
        msSinceLastAttempt: this.msSinceRecovery(),
        cooldownMs: RECOVERY_COOLDOWN_MS,
      });
      if (!decided) {
        // A device that has never answered is booting, not broken — the boot
        // ladder owns that case and has its own budget for the same cure — so
        // the default "restarted too recently" wording would be actively
        // misleading here.
        throw answered
          ? new SimulatorNotAnsweringError(false)
          : new SimulatorNotAnsweringError(
              false,
              "The simulator is not answering accessibility reads, and has not " +
                "served one yet, so it is most likely still booting."
            );
      }
      if (!(await this.recoverWedgedAccessibility())) {
        throw new SimulatorNotAnsweringError(true);
      }

      for (let attempt = 0; attempt < POST_RECOVERY_READ_ATTEMPTS; attempt++) {
        await this.deps.sleep(POST_RECOVERY_READ_DELAY_MS);
        try {
          return await read();
        } catch (retryError) {
          // Anything other than the wedge is a real answer to the caller's
          // request, and waiting longer will not change it.
          if (!isWedgeError(toError(retryError).message)) throw retryError;
        }
      }
      throw new SimulatorNotAnsweringError(true);
    }
  }

  // ---- reading: the raw reads ---------------------------------------------

  /**
   * The unpruned accessibility tree for the whole screen, with the full cure
   * ladder around it. Ports `describeAll` (index.ts:94). Internal: the raw tree
   * is deliberately not public (SIMGADGET.md's Decisions register), and
   * `screenSize()` serves the only thing callers ever took from it.
   *
   * A companion that has been up for a while can wedge into serving a 0x0 tree
   * for a simulator that is perfectly healthy — a freshly spawned companion
   * serves the same simulator correctly at the same moment. Since we own the
   * companion, the cure is to restart it and ask again, which the caller never
   * sees. That used to require recreating the simulator and losing its apps.
   *
   * An empty tree that survives that restart is the *guest* side of the same
   * symptom, and the cure there is to restart the simulator's bridge — so both
   * are tried before anyone sees a failure. `withAccessibilityRecovery` covers
   * the third shape, where the read throws instead of returning nothing.
   */
  private async describeAll(): Promise<AXElement[]> {
    const read = () =>
      this.deps.withClient(this.udid, async (client) => {
        const info = await client.accessibilityInfo({ format: Format.NESTED });
        // An empty read comes back as JSON null, which must not become [null]
        // -- that reads as a one-element tree and would be returned as success.
        if (info == null) return [] as AXElement[];
        return (Array.isArray(info) ? info : [info]) as AXElement[];
      });

    const usable = (elements: AXElement[]) => {
      if (isDegenerateTree(elements)) return false;
      this.markAnswered();
      return true;
    };

    return this.withAccessibilityRecovery(async () => {
      let elements = await read();
      if (usable(elements)) return elements;

      await this.deps.shutdownCompanion(this.udid);
      elements = await read();
      if (usable(elements)) return elements;

      // Only for a simulator that has answered before; a fresh one is booting.
      // Without this gate every new simulator gets its bridge restarted within
      // a second of the first call.
      if (
        this.deps.recovery.hasAnswered(this.udid) &&
        (await this.recoverWedgedAccessibility())
      ) {
        elements = await read();
        usable(elements);
      }
      return elements;
    });
  }

  /**
   * The pruned screen tree, without the degenerate-tree ladder around it.
   * Ports `describeScreen` (index.ts:144); `describeScreen()` below adds
   * today's `ui_describe_all` tool body on top.
   *
   * Separate from `describeAll` because the two want opposite things. Callers
   * that only need the root frame — orientation, screen dimensions, a
   * screenshot's resize — are served by the cheap read in ~13ms, and making
   * them pay for this one would be a sixfold regression for a rectangle they
   * already had.
   *
   * AXBridge, because the default backend does not return a usable screen: tab
   * bars, nav bars and toolbars arrive as containers with no children, so their
   * controls are absent from the tree entirely even though they are on screen
   * and tappable. That is worth ~300ms and a larger payload, because the
   * cheaper answer is wrong in a way a caller cannot detect.
   */
  private async readScreenTree(): Promise<AXElement[]> {
    const elements = await this.withAccessibilityRecovery(() =>
      this.deps.withClient(this.udid, async (client) => {
        const read = async (backend?: Backend, keys?: string[]) => {
          const info = await client.accessibilityInfo({
            format: Format.NESTED,
            backend,
            keys,
          });
          if (info == null) return [] as AXElement[];
          return (Array.isArray(info) ? info : [info]) as AXElement[];
        };

        try {
          return await read(Backend.AXBRIDGE, DESCRIBE_KEYS);
        } catch {
          // A companion older than the one this library pins cannot start
          // AXBridge. An incomplete tree beats no tree, so fall back rather
          // than fail.
          return await read();
        }
      })
    );

    if (!isDegenerateTree(elements)) this.markAnswered();
    // Translate before pruning, which discards the parents the offsets are
    // read from. Getting this order wrong reintroduces the bug where a tap
    // inside a sheet lands 476 points away and reports success.
    return pruneTree(translateRemoteSubtrees(elements));
  }

  /**
   * Why the tree is empty after both cures have been tried, and whether the
   * diagnosis cured it on the way.
   *
   * Ports `diagnoseEmptyAccessibilityTree` (index.ts:637) as a verdict rather
   * than as prose: the GitHub issue URL and the "call this other tool instead"
   * remediation are the host's to render from `code` + `verdict` (design rule
   * 5), and everything left is a fact.
   *
   * A point query answering while the tree stays empty is the wedge, so the
   * cheap cure is attempted here too — it keeps the device and its apps, where
   * recreating the simulator, what this used to recommend, costs every
   * installed app for the same result. Usually the cooldown makes it a no-op
   * saying it was already tried moments ago; the one path where it is not is a
   * simulator that has never answered a *tree* read, which `describeAll`'s gate
   * refuses to restart for and whose point reads nonetheless work.
   */
  private async diagnoseEmptyTree(): Promise<{
    verdict: "booting" | "unrecoverable";
    recovered: boolean;
  }> {
    let booted = false;
    for (let attempt = 0; attempt < DIAGNOSTIC_POINT_PROBES && !booted; attempt++) {
      booted = await this.accessibilityPointAnswers();
    }
    if (!booted) return { verdict: "booting", recovered: false };

    return { verdict: "unrecoverable", recovered: await this.recoverWedgedAccessibility() };
  }

  // ---- reading: the public verbs ------------------------------------------

  /**
   * The screen as a caller should see it. Absorbs today's `ui_describe_all`
   * tool body (index.ts:1548-1560): when the pruned read comes back degenerate,
   * run `describeAll`'s whole ladder of cures — restart our companion, then the
   * simulator's bridge — and ask again if it brings the screen back. Returning
   * the screen beats returning an error that tells the caller to retry the call
   * themselves.
   */
  async describeScreen(): Promise<ScreenRead> {
    this.assertNotDeleted();

    let elements = await this.readScreenTree();
    if (isDegenerateTree(elements)) {
      if (!isDegenerateTree(await this.describeAll())) {
        elements = await this.readScreenTree();
      }
      if (isDegenerateTree(elements)) {
        const { verdict, recovered } = await this.diagnoseEmptyTree();
        // The diagnosis's own cure took: one more read rather than an error
        // asking the caller to make it (design rule 1).
        if (recovered) elements = await this.readScreenTree();
        if (isDegenerateTree(elements)) throw new AccessibilityUnreadableError(verdict);
      }
    }

    return { elements, screen: this.screenFrom(elements) };
  }

  /**
   * Logical screen dimensions from the cheap (~13ms) unpruned read — today's
   * `getScreenDimensions` (index.ts:603) without the caching, which is now
   * `noteRootFrame`'s business. This replaces public access to the raw tree,
   * which no caller of the old code ever consumed for anything else
   * (SIMGADGET.md's Decisions register).
   */
  async screenSize(): Promise<{ width: number; height: number }> {
    this.assertNotDeleted();

    let elements = await this.describeAll();
    if (isDegenerateTree(elements)) {
      const { verdict, recovered } = await this.diagnoseEmptyTree();
      if (recovered) elements = await this.describeAll();
      if (isDegenerateTree(elements)) throw new AccessibilityUnreadableError(verdict);
    }
    return this.screenFrom(elements);
  }

  /**
   * The rectangle a non-degenerate read's root carries, recorded on the way
   * past. Zeroes are unreachable in practice — `isDegenerateTree` has already
   * rejected a 0x0 root — but a root with no frame at all is not degenerate by
   * that rule, and a screen is a better answer than a crash.
   */
  private screenFrom(elements: AXElement[]): { width: number; height: number } {
    const frame = elements[0]?.frame;
    if (frame) this.noteRootFrame(frame);
    return { width: frame?.width ?? 0, height: frame?.height ?? 0 };
  }

  /**
   * Resolves an element by its accessibility identifier — exact, where a label
   * is a substring that can drift onto something else as a screen changes.
   * Ports `findByIdentifier` (index.ts:180).
   *
   * No AXBridge fallback: this exists to re-read an element the caller has
   * already found, so a miss means it has genuinely gone rather than that a
   * backend cannot see it, and paying ~300ms to confirm a disappearance helps
   * nobody.
   */
  async findByIdentifier(identifier: string): Promise<AXElement | null> {
    this.assertNotDeleted();
    return this.findByMarker(identifier, SearchableKey.UNIQUE_ID);
  }

  /**
   * Resolves a single element by the text a caller knows it by. Ports
   * `findByLabel` (index.ts:232).
   *
   * Cheap path first: the companion matches a marker server-side and returns
   * just that element, roughly half a kilobyte against several for a whole
   * tree, in ~13ms. Most lookups end there.
   *
   * When it misses, the fallback reads the screen and matches here. That covers
   * three separate failures the marker query cannot:
   *
   *  - Apple's translator omits whole containers, so a control in a tab bar,
   *    nav bar or toolbar is absent from the tree the marker query searches
   *    even though it carries the label and hit-tests fine. The AXBridge read
   *    sees the app's real view hierarchy instead.
   *  - The match is on `AXLabel` only, but a control's visible text is not
   *    always its label — search fields in particular have a null label and
   *    their text in `AXValue`, making them unnameable.
   *  - The match is exact, so a caller's ASCII apostrophe never finds iOS's
   *    typographic one.
   *
   * One fallback rather than a chain of marker retries: it is a single round
   * trip (~350ms against ~300ms for another marker query), and matching here
   * means the comparison is ours to fix rather than the companion's to be exact
   * about.
   */
  async findByLabel(label: string): Promise<AXElement | null> {
    this.assertNotDeleted();

    const marker = await this.findByMarker(label, SearchableKey.LABEL);
    if (marker) return marker;

    // An accessibility identifier is the other name an element has, and the
    // tree publishes it — so a caller reading `AXUniqueId:
    // "PlainStepper-Increment"` off a describe and handing it straight back is
    // doing the obvious thing. Before this it got "not found" for a name it had
    // just been given. Second, not first: a label is what a caller usually
    // means, and this costs another ~15ms only once that has missed.
    const byId = await this.findByMarker(label, SearchableKey.UNIQUE_ID);
    if (byId) return byId;

    let tree: AXElement[];
    try {
      tree = await this.readScreenTree();
    } catch {
      // The fallback is best-effort: if the screen cannot be read, the honest
      // answer is still "not found" rather than an error about a backend the
      // caller never asked for.
      return null;
    }

    return matchInTree(tree, label);
  }

  /**
   * One server-side marker query, shared by both lookups because they differ
   * only in which key is matched.
   *
   * `canonicalise` also drops the subtree the match arrives with. On the home
   * screen that is nothing, but a match inside an app can drag ten kilobytes of
   * descendants along with it, which would defeat the point of asking for one
   * element; callers wanting structure have `describeScreen`.
   */
  private async findByMarker(
    marker: string,
    matchKey: SearchableKey
  ): Promise<AXElement | null> {
    return this.withAccessibilityRecovery(() =>
      this.deps.withClient(this.udid, async (client) => {
        try {
          const found = (await client.accessibilityInfo({
            marker,
            matchKey,
            keys: DESCRIBE_KEYS,
          })) as { elements?: AXElement } | null;
          this.markAnswered();
          const element = found?.elements;
          return element ? canonicalise(element) : null;
        } catch (error) {
          // "found no element" is how the companion reports an empty result,
          // and is not a failure. Anything else is — including the wedge, which
          // the wrapper above cures and retries. A search that reached the tree
          // at all is proof the bridge is alive.
          if (isNoElementError(toError(error).message)) {
            this.markAnswered();
            return null;
          }
          throw error;
        }
      })
    );
  }

  /**
   * The element at a logical-space point, or `null` when nothing is there.
   * Absorbs the `ui_describe_point` tool body (index.ts:2110-2152).
   *
   * A frame nowhere near the point it was found at is the signature of a
   * remote-hosted view: the hit-test is right, the frame is measured from the
   * hosting window rather than the screen. The tree read that corrects it costs
   * ~300ms, so it is paid only here, on the reads that are otherwise wrong —
   * and only to replace the rectangle, never the identity, which the point read
   * established by hit-testing.
   */
  async describePoint(x: number, y: number): Promise<AXElement | null> {
    this.assertNotDeleted();

    const portrait = this.toPortrait(x, y);
    let element = await this.readPoint(portrait.x, portrait.y);
    if (!element) return null;

    if (element.frame && isRemotelyHosted(element.frame, x, y)) {
      try {
        const corrected = locateInTree(await this.readScreenTree(), element, x, y);
        if (corrected) element = { ...element, frame: corrected };
      } catch {
        // Best effort: the point read's own answer beats an error about a
        // second read the caller never asked for.
      }
    }

    return element;
  }

  /**
   * The accessibility element at a point in **portrait** coordinates. Ports
   * `describePoint` (index.ts:305) and stays private: `detectOrientation`'s
   * probes (step 4) and `tap`'s hit-test (step 5) both need the untransformed,
   * uncorrected form (DECISIONS.md #10).
   *
   * LEGACY, not NESTED, to match what `idb ui describe-point` sent: the Python
   * client only asked for NESTED when given --nested, which describe-point
   * never passed. Asking for NESTED here returns the element's whole subtree
   * instead of the single element callers expect.
   *
   * Same key set as every other read, so one element looks the same however a
   * caller arrived at it. Left to the companion's defaults, the backends
   * disagree about their own output: the AX backend calls a tab
   * `role: "AXRadioButton"` with populated `traits`, and axbridge calls the same
   * element `role: "Button"` with `traits: null`. Asking for the fields both
   * agree on retires the problem rather than papering over it, and `type`
   * carries what `role` was for.
   */
  private async readPoint(x: number, y: number): Promise<AXElement | null> {
    return this.withAccessibilityRecovery(async () => {
      try {
        return await this.deps.withClient(this.udid, async (client) => {
          const element = (await client.accessibilityInfo({
            point: { x: Math.round(x), y: Math.round(y) },
            format: Format.LEGACY,
            keys: POINT_KEYS,
          })) as AXElement | null;
          if (!element) return null;
          // This backend has its own names for things. Say what the tree would.
          element.type = reconcileType(element.type, element.subrole);
          // A real frame, not merely a reply: a booting simulator answers a
          // point read with an empty 0x0 element before its bridge is up.
          if (element.frame && (element.frame.width || element.frame.height)) {
            this.markAnswered();
          }
          return canonicalise(element);
        });
      } catch (error) {
        // idb raises one error for two unrelated things: a bridge that is not
        // answering, and a point with nothing on it. Only a point read can mean
        // the second, so this is the one place that has to tell them apart —
        // and it must, because the caller who taps an empty patch of screen
        // would otherwise have the simulator's bridge restarted underneath
        // them. Asking for the whole screen is the disambiguation: it has no
        // such ambiguity.
        if (
          isWedgeError(toError(error).message) &&
          (await this.accessibilityIsAnswering())
        ) {
          this.markAnswered();
          // Absent is an answer, not an error (design rule 3).
          return null;
        }
        throw error;
      }
    });
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
