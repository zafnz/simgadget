/**
 * The `Simulator` handle — SIMGADGET.md, "The `Simulator` handle".
 *
 * Step 2b (SIMGADGET_PLAN.md) added the lifecycle and app methods: `boot()`,
 * `waitReady()`, `state()`, `shutdown()`, `delete()`, `installApp`,
 * `launchApp`, `restartBridge()`, `releaseCompanion()`. Step 3 adds the
 * reading half — `describeScreen()`, `screenSize()`, `findByLabel()`,
 * `findByIdentifier()`, `describePoint()` — and the wedge-recovery machinery
 * underneath all of them. Step 4 adds orientation: `rotate()`,
 * `detectOrientation()`, and the coordinate contract's three lifetimes of
 * state. Step 5 adds acting: `tap()`, `typeText()`, `swipe()`,
 * `pressButton()`. Step 6 adds capture: `screenshot()`, `startRecording()`,
 * `stopRecording()` — thin, because the pipeline underneath them is about
 * `simctl`, `sips` and a child process rather than about a simulator, and
 * lives in `./capture.ts` accordingly.
 *
 * Every impure call goes through `this.deps` (`./internal/deps.ts`), never
 * `child_process` or a companion singleton directly — the fake-client test
 * layer depends on that seam being the only door to the outside world.
 */

import {
  BOOT_READY_TIMEOUT_MS,
  findDevice,
  parseLaunchPid,
  BRIDGE_SERVICE,
  isAlreadyBootedError,
  isInvalidDeviceError,
  restartSimulatorBridge,
  waitUntilDriveable,
  type DeviceTypeInfo,
  type Orientation,
  type ReadyResult,
  type SimulatorState,
} from "./lifecycle.ts";
import type { SimulatorDeps } from "./internal/deps.ts";
import {
  AccessibilityUnreadableError,
  ElementDisabledError,
  ElementNotFoundError,
  SimGadgetError,
  SimulatorNotAnsweringError,
  SimulatorNotFoundError,
  TapObstructedError,
  ToggleGestureError,
  UntypeableTextError,
} from "./errors.ts";
// Two element types, and the names say which is which (DECISIONS.md #4).
// `ax/tree.ts`'s `RawAXElement` is the open type the companion speaks — free
// JSON, nulls and all — and is what the raw reads below deal in. `AXElement`,
// the name on every public signature, is the closed type from the spec, and
// the one that same file publishes. `canonicalise` is the crossing between
// them, and the only one.
import {
  DESCRIBE_KEYS,
  POINT_KEYS,
  canonicalise,
  centreOf,
  collectProbeCandidates,
  isDegenerateTree,
  isRemotelyHosted,
  locateInTree,
  matchInTree,
  pruneTree,
  reconcileType,
  sameElement,
  translateRemoteSubtrees,
  uniquelyLabelled,
  type AXElement,
  type RawAXElement,
  type Frame,
} from "./ax/tree.ts";
import { decideTapVerb, holdSeconds } from "./ax/tap.ts";
import { isNoElementError, isWedgeError, shouldRecover } from "./ax/recovery.ts";
// `ax/orientation.ts`'s own `Orientation` is the *hint* vocabulary — the four
// device orientations plus `"auto"` — and is deliberately a different type from
// the public one (DECISIONS.md #3). Aliased at the use site, as that decision
// asks, rather than renamed at the source.
import {
  candidateOrientations,
  getEffectiveOrientation,
  reconcileHint,
  transformPointToPortrait,
  type Orientation as OrientationHint,
} from "./ax/orientation.ts";
import {
  captureScreenshot,
  pointDimensions,
  recordingArgs,
  stopRecordingProcess,
  trackRecording,
  waitForRecordingStart,
  type RecordingOptions,
  type Screenshot,
  type ScreenshotOptions,
} from "./capture.ts";
import { Backend, Button, Format, OrientationType, SearchableKey } from "./idb/client.ts";
import type { IdbClient } from "./idb/client.ts";
import type { WithClientOptions } from "./idb/companionManager.ts";
import { unmappedCharacters } from "./idb/keymap.ts";
import type { ChildProcess } from "child_process";
import { existsSync } from "fs";
import path from "path";

export interface ScreenRead {
  /** Pruned tree; `elements[0]` is the screen root carrying the full frame. */
  elements: AXElement[];
  /** Logical dimensions from that root frame — the space every coordinate in
   * `elements`, and every coordinate handed back in, lives in. */
  screen: { width: number; height: number };
}

export interface RotateResult {
  requested: Orientation;
  /** Detected by probing, not assumed — apps decline orientations (no Face ID
   * iPhone ever adopts upside_down). Coordinates now follow this. */
  adopted: Orientation;
}

/**
 * Where a tap is aimed. The two are different verbs kept under one name because
 * callers think of them as one; `tap`'s doc comment has the difference.
 */
export type TapTarget = { x: number; y: number } | { label: string };

export interface TapOptions {
  /** Press duration in seconds. A floor of 0.1s is always applied — an
   * instantaneous touch actuates a control about half the time (measured
   * 5/12; with the floor 12/12) — so passing less changes nothing about the
   * touch itself. Above ~0.5s UIKit reads it as a long press.
   *
   * One thing it does change, and the one place the number and the asking
   * come apart: on a `{label}` tap at a **toggle**, setting this at all makes
   * the gesture a hold, and a hold at a toggle is refused with
   * `ToggleGestureError` — including at a value under the floor, where the
   * touch delivered would have been identical to the default one. Asking for
   * a duration is what marks a caller as wanting a real press, and a real
   * press at a toggle's centre lands in the gap beside the control. Omit it
   * to get the activation that works. */
  durationSeconds?: number;
  /** Number of taps; 2 = double-tap. Default 1. */
  count?: number;
}

/**
 * What a tap did, and what it read back. There is no success that carries no
 * information: "Tapped successfully" is the bug class this whole library was
 * reshaped to kill, because a tap that hit the wrong control, a tap that landed
 * 40% of the time and a tap that actuated nothing each reported exactly that
 * same cheerful string.
 */
export type TapResult =
  | {
      /** A real synthesized touch was delivered. */
      acted: "touch";
      /** Logical coordinates the touch landed at — the element's centre when
       * aimed by label, the caller's own coordinates otherwise. Never the
       * portrait-space pair actually sent: reporting those would answer a
       * landscape tap at (162, 352) with "tapped at (50, 163)", a coordinate in
       * a space the caller does not use and cannot check against the tree. */
      x: number;
      y: number;
      count: number;
      durationSeconds: number;
      /** Present when aimed by label: the element that was resolved and
       * hit-test-verified. Absent for a coordinate tap — coordinates are the
       * caller saying where, and are taken at their word.
       *
       * Names *what* was tapped, not merely that something was: matching is a
       * substring and the companion returns the first hit, so the element found
       * is not always the one meant — a status line reading "Settings Switch =
       * on" has outranked the switch it was describing, and a permission
       * alert's sentence has outranked an app icon. */
      element?: AXElement;
    }
  | {
      /** A toggle was operated through accessibility (`AXPress` — the
       * activation VoiceOver performs), because a toggle's frame is routinely
       * not its actuating region and no coordinate can hit it. */
      acted: "activation";
      element: AXElement;
      before?: string | number;
      /** Undefined when the state could not be read back — the host must be
       * able to say so rather than claim success. When defined and equal to
       * `before`, the activation did not take (most often: the control is
       * scrolled out of view). */
      after?: string | number;
    };

/**
 * Our button names to idb's `HIDButtonType`. Straight through, unlike
 * `HID_ORIENTATION` further down this file — the two vocabularies agree about
 * buttons because there is only one thing a home button can mean.
 */
const HID_BUTTON: Record<
  "home" | "lock" | "side-button" | "siri" | "apple-pay",
  Button
> = {
  home: Button.HOME,
  lock: Button.LOCK,
  "side-button": Button.SIDE_BUTTON,
  siri: Button.SIRI,
  "apple-pay": Button.APPLE_PAY,
};

/**
 * The pause between the taps of a multi-tap.
 *
 * Long enough that the companion's HID events do not arrive as one smeared
 * gesture, short enough to stay inside UIKit's double-tap window — which is
 * what a caller asking for `count: 2` means by it.
 */
const TAP_REPEAT_GAP_MS = 50;

/**
 * Our orientation names to idb's `HIDOrientationType`.
 *
 * **The landscapes are crossed on purpose, and this is the whole subtlety of
 * rotation.** Both enums spell the same four words, but they mean different
 * things by them: ours names the *device*, as the Simulator's own menus do,
 * while idb's turns out to use UIKit's *interface* vocabulary — and UIKit
 * defines `UIInterfaceOrientationLandscapeLeft` as
 * `UIDeviceOrientationLandscapeRight` (see `./ax/orientation.ts`).
 *
 * Measured, not assumed. A name-for-name map was written first and the fixture
 * caught it immediately: asking for `landscape_left` produced an app reporting
 * `device=landscapeRight interface=landscapeLeft`, i.e. the mirror image, and
 * `rotate` duly answered "you asked for landscape_left, the interface is
 * landscape_right". Reading the orientation back rather than trusting the
 * request is what turned a silently inverted coordinate space into a visible
 * disagreement, and is worth keeping for that reason alone.
 *
 * @internal Exported for the table-driven test that stops a future reader
 * "fixing" the crossing back to name-for-name. Not part of the public surface.
 */
export const HID_ORIENTATION: Record<
  "portrait" | "upside_down" | "landscape_left" | "landscape_right",
  OrientationType
> = {
  portrait: OrientationType.PORTRAIT,
  upside_down: OrientationType.PORTRAIT_UPSIDE_DOWN,
  landscape_left: OrientationType.LANDSCAPE_RIGHT,
  landscape_right: OrientationType.LANDSCAPE_LEFT,
};

/**
 * How long to let a rotation animate before reading the tree.
 *
 * The accessibility tree reports the old geometry until the rotation finishes,
 * so reading too early returns the orientation we were in rather than the one
 * we asked for.
 */
const ROTATION_SETTLE_MS = 1_500;

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

/**
 * A toggle's state as `TapResult` carries it. The narrowing to the two things a
 * companion ever reports a value as is `canonicalise`'s now; what is left here
 * is the element that could not be read back at all, which becomes `undefined`
 * — the case the result exists to make visible.
 */
function toggleValue(element: AXElement | null): string | number | undefined {
  return element?.AXValue;
}

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

/**
 * What a handle needs beyond its udid, name and dependencies. An options bag
 * rather than more positional parameters: this is the second thing to be added
 * here and there will be a third.
 */
export interface HandleOptions {
  /** The model this simulator was created as. `createSimulator` knows it for
   * free; an attached handle never resolves one. */
  deviceType?: DeviceTypeInfo;
  /** Where the handle's own diagnostics go — today, the wedge recovery's.
   * Omitted means silent, which is what a library should be by default. */
  onLog?: (message: string) => void;
}

export class Simulator {
  readonly udid: string;
  readonly name: string;

  /**
   * The device type this simulator was created as — `{identifier, name}`,
   * where `name` is the model a person says ("iPhone 16 Pro") and
   * `identifier` is what `simctl create` takes.
   *
   * **`undefined` on an attached handle, honestly rather than awkwardly.**
   * `createSimulator` resolves the device type on its way to `simctl create`
   * and so knows it for free; `attachSimulator` adopts a udid and never looks
   * one up. A caller that needs it for an attached simulator can pay a
   * `listSimulators()` for the identifier — which is why this is a field a
   * creator fills rather than a lookup the handle performs.
   *
   * Exists because the answer to `start_simulator` names the model: an agent
   * asks for "iPhone" and the reply is the only place it learns *which*
   * iPhone it got.
   */
  readonly deviceType?: DeviceTypeInfo;

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

  /**
   * The *portrait* point dimensions — the second of the coordinate contract's
   * three lifetimes, and the only one **cached forever**. A udid's device type
   * is fixed at creation, so these are a property of the model rather than of
   * anything on screen: nothing a caller can do changes them, so nothing has to
   * invalidate them (DECISIONS.md #6).
   */
  private portraitPoints: { width: number; height: number } | null = null;

  /**
   * The third lifetime: which orientation this handle believes the interface
   * is in, in the *hint* vocabulary, so `"auto"` can mean "nobody has told me,
   * derive it from the shape of the screen".
   *
   * Per handle, not per udid, and the spec says so: two handles on one
   * simulator each carry their own, and an external rotation between the two
   * landscapes is invisible to both until someone calls `detectOrientation()`.
   * That is the documented hazard in the coordinate contract, not an oversight.
   *
   * Written authoritatively by `rotate()` and `detectOrientation()`, and
   * retired to `"auto"` by `noteRootFrame` when a describe contradicts its
   * aspect.
   */
  protected orientationHint: OrientationHint = "auto";

  /**
   * The one recording this handle may have running, and where it is being
   * written.
   *
   * **Per handle, not per udid**, which is the spec's wording and the reason
   * `stopRecording()` can answer with a path at all: it is the same
   * per-session slot today's `activeRecordings` map keys by session id
   * (index.ts:2434), and two handles on one simulator recording to two files
   * is a thing simctl itself allows. Cleared when the process exits on its
   * own, so a recording that died leaves the handle able to start another
   * rather than permanently "already active".
   */
  private recording: { child: ChildProcess; path: string } | null = null;

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
  constructor(
    udid: string,
    name: string,
    deps: SimulatorDeps,
    opts: HandleOptions = {}
  ) {
    this.udid = udid;
    this.name = name;
    this.deps = deps;
    this.deviceType = opts.deviceType;
    this.onLog = opts.onLog;
  }

  /**
   * Where this handle's diagnostics go, if anywhere.
   *
   * Silence is the default and the right one for a library: a `console.error`
   * a caller did not ask for is a library writing to somebody else's stdout.
   * But the wedge recovery is the one thing here that acts on its own — it
   * restarts a service inside the guest, waits, and retries the caller's read
   * — and it did so invisibly after the port, which cost TESTING_SERVER.md's
   * recovery section its only observable and turned one of its steps into a
   * check that could never fail (TODO #100).
   */
  private readonly onLog?: (message: string) => void;

  /** One line of diagnostics, dropped when nobody is listening. */
  private log(message: string): void {
    this.onLog?.(message);
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

  /**
   * Every companion call this class makes, with a failure resolved against
   * simctl before it is reported.
   *
   * The spec promises `SimulatorNotFoundError` from *every* method on a
   * simulator deleted underneath a live handle — "a clear error, never a gRPC
   * timeout". `mapSimctlError` can only deliver that for the methods that go
   * through simctl (`state()`, the app calls); every read and every tap goes
   * out over the companion, and there is no single shape those come back in:
   * a companion spawned for a udid that no longer exists cannot resolve its
   * target and exits (`CompanionStartError`), while a udid that already had
   * one fails somewhere else entirely — including the manager's own refusal
   * to start a companion for a udid `delete()` has closed, which arrives
   * already typed and is rethrown as it stands, since simctl still lists a
   * device that is mid-deletion. Chasing the shapes is how half of this went
   * missing the first time.
   *
   * So the question is asked of the only thing that can answer it: a failed
   * companion call consults simctl, and only a udid that is genuinely gone is
   * renamed. Everything else is rethrown exactly as it arrived — a companion
   * that could not start against a simulator still sitting there keeps its
   * own error and its `stderrTail`, because that is a real fault and "not
   * found" would send whoever reads it looking in the wrong place.
   *
   * The wedge vocabulary is exempt and must stay exempt. Those errors are a
   * statement about a bridge belonging to a simulator that plainly exists,
   * `withAccessibilityRecovery` reads them to decide on the cure, and they
   * are the one companion failure that happens often enough for a `simctl
   * list` per attempt to be worth avoiding.
   */
  private async withClient<T>(
    fn: (client: IdbClient) => Promise<T>,
    options?: WithClientOptions
  ): Promise<T> {
    try {
      return await this.deps.withClient(this.udid, fn, options);
    } catch (error) {
      if (isWedgeError(toError(error).message)) throw error;
      try {
        // Present, or simctl could not be asked: either way the failure that
        // actually happened is the most truthful thing we have.
        if (await findDevice(this.deps, this.udid)) throw error;
      } catch {
        throw error;
      }
      throw new SimulatorNotFoundError(this.udid);
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

    await this.showWindow();

    const ready = await waitUntilDriveable(this.deps, this.udid, budgetMs, (m) => this.log(m));
    this.recordBoot(ready);
    return ready;
  }

  /**
   * Brings the Simulator.app window to the front for this simulator, without
   * booting or waiting for anything.
   *
   * Separate from `boot()` because the MCP's resume path wants exactly this
   * and nothing else: a session reconnecting to a simulator that is already
   * up needs its window visible again, and `boot()` — the only other place
   * that opens the app (DECISIONS.md #1) — would charge it the whole
   * driveability ladder, whose settle is unconditional. Sub-second here,
   * eight seconds and change there, on the call an agent makes most often
   * after a disconnect.
   *
   * `open -a` raises whatever Simulator.app is showing rather than choosing a
   * device, which is why this takes no argument and promises no more than it
   * does: with several simulators booted, the frontmost window is not
   * necessarily this one. Booting is what makes a device frontmost, and this
   * method is deliberately not that.
   */
  async showWindow(): Promise<void> {
    this.assertNotDeleted();
    await this.deps.run("open", ["-a", "Simulator.app"]);
  }

  /** Waits (without booting) until an accessibility read answers with a real
   * frame. This is what the MCP's `attach_simulator` does after adopting.
   * Same ladder as `boot()`'s wait, so "costs nothing when already up" is as
   * true here as it is there: `simctl bootstatus` on an already-booted
   * device returns immediately. */
  async waitReady(opts?: { budgetMs?: number }): Promise<ReadyResult> {
    this.assertNotDeleted();
    const budgetMs = opts?.budgetMs ?? BOOT_READY_TIMEOUT_MS;
    const ready = await waitUntilDriveable(this.deps, this.udid, budgetMs, (m) => this.log(m));
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
   *
   * Before any of that, a recording this handle started is stopped. Deleting
   * the device out from under `simctl io ... recordVideo` does not stop it:
   * observed leaving a recorder running six minutes later against a udid that
   * no longer existed. Stopping first is also the only ordering that can
   * finalize the file, since after the delete there is nothing left to record.
   */
  async delete(): Promise<void> {
    this.assertNotDeleted();

    if (this.recording) {
      try {
        await this.stopRecording();
      } catch {
        // Best effort. A recording that could not be stopped must not block
        // the delete — the exit hook is the backstop for it, and a caller who
        // asked for the simulator to be gone should get that.
      }
    }

    await this.deps.closeCompanion(this.udid);

    try {
      try {
        await this.deps.run("xcrun", ["simctl", "shutdown", this.udid]);
      } catch {
        // May already be shut down.
      }
      await this.runSimctl(["delete", this.udid]);
    } catch (error) {
      // The close above blocks every companion for this udid, and it stays
      // blocked until something reopens it. On the success path nothing
      // should: the simulator is gone. On a failure path the simulator is
      // still there and still meant to be drivable, and without this the udid
      // is wedged shut for the whole process — every later read, from any
      // handle, dying inside `companionFor` with an untyped "is being shut
      // down".
      //
      // Unless the failure is that it had already been deleted, in which case
      // the caller's wish has been granted by someone else: mark the handle
      // stale and drop the recovery state exactly as a successful delete
      // does, so the error is the only difference between the two.
      if (error instanceof SimulatorNotFoundError) {
        this.deleted = true;
        this.deps.recovery.forget(this.udid);
      } else {
        this.deps.reopenCompanion(this.udid);
      }
      throw error;
    }

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

    return { pid: parseLaunchPid(stdout) };
  }

  // ---- reading: the two funnels later steps hang off ----------------------

  /**
   * Logical → portrait coordinates, the space the companion's point reads and
   * touches accept. Every coordinate this library sends to a companion crosses
   * the gap here and nowhere else.
   *
   * Async because the transform needs the logical screen rectangle, and a
   * handle that has not read the screen yet does not have one — today's
   * `getScreenDimensions` (index.ts:603) has the same shape for the same
   * reason. With no dimensions available at all the point is passed through
   * untouched, which is what the tool bodies this ports (index.ts:1878,
   * index.ts:2111) did: a portrait device is the overwhelmingly common case and
   * the identity is right for it.
   */
  private async toPortrait(x: number, y: number): Promise<{ x: number; y: number }> {
    return (await this.portraitTransform())(x, y);
  }

  /**
   * The same transform, resolved once and then applied as many times as a
   * gesture has endpoints.
   *
   * A swipe is why this exists rather than two `toPortrait` calls: the first
   * call can be the read that refreshes the screen rectangle and retires the
   * orientation hint, so a second call would transform the far end of the
   * gesture in a *different* space from the near end — a swipe in a direction
   * nobody asked for. Resolving the space once makes that structurally
   * impossible instead of merely unlikely.
   */
  private async portraitTransform(): Promise<
    (x: number, y: number) => { x: number; y: number }
  > {
    const dims = await this.logicalDimensions();
    if (!dims) return (x, y) => ({ x, y });
    const orientation = getEffectiveOrientation(
      this.orientationHint,
      dims.width,
      dims.height
    );
    return (x, y) =>
      transformPointToPortrait(x, y, orientation, dims.width, dims.height);
  }

  /**
   * The logical screen rectangle, from the cache when there is one and from a
   * fresh cheap read when there is not. Ports `getScreenDimensions`
   * (index.ts:603); the caching half of it is `noteRootFrame`'s business now.
   *
   * `null` rather than a throw when the read yields no usable frame: this is
   * called on the way to doing something else, and a caller who asked to tap
   * is better served by the tap's own failure than by an error about a
   * measurement they never requested.
   */
  private async logicalDimensions(): Promise<{ width: number; height: number } | null> {
    if (this.screenDims) return this.screenDims;

    const frame = (await this.describeAll())[0]?.frame;
    if (!frame || !frame.width || !frame.height) return null;
    this.noteRootFrame(frame);
    return this.screenDims;
  }

  /**
   * The portrait point dimensions, fetched once and kept.
   *
   * The one deliberate piece of new code in this phase rather than a port: they
   * come from the companion's `describe` (contract check 9 pins that it reports
   * both pixels and points), where today they are inferred from an
   * accessibility root frame. `describe` answers from target metadata, so it
   * works while the bridge is still silent — dimensions are available before
   * the simulator is driveable, which the accessibility-read source never was.
   *
   * `null` when the companion answers without them. There is no `ErrorCode` for
   * "a field was missing from a describe", and inventing one to cover a case
   * contract check 9 exists to catch would be worse than letting the one caller
   * that needs them — step 6's `screenshot({resizeTo: "points"})` — decide what
   * to do without.
   */
  protected async portraitPointDimensions(): Promise<{
    width: number;
    height: number;
  } | null> {
    if (this.portraitPoints) return this.portraitPoints;

    const dimensions = (
      await this.withClient((client) => client.describe())
    ).screenDimensions;
    if (!dimensions?.widthPoints || !dimensions.heightPoints) return null;

    this.portraitPoints = {
      width: dimensions.widthPoints,
      height: dimensions.heightPoints,
    };
    return this.portraitPoints;
  }

  /**
   * The one place a describe's root frame is recorded, and the first two of the
   * coordinate contract's three lifetimes meeting.
   *
   * The logical dimensions are simply the frame. The orientation *aspect* is
   * free here too — a root wider than it is tall is a device on its side — and
   * `reconcileHint` is where that fact is allowed to argue with the hint: it
   * retires a hint the frame contradicts and leaves an agreeing one alone,
   * because chirality is not visible in any frame and must survive every read
   * that does not disprove it (DECISIONS.md #8).
   *
   * A zero-sized frame is not recorded: a booting simulator answers with one,
   * and caching it would hand every later coordinate transform a screen with
   * no size — and let a 0x0 root, which is no shape at all, retire a hint that
   * a probe paid for.
   */
  private noteRootFrame(frame: Frame): void {
    if (frame.width && frame.height) {
      this.screenDims = { width: frame.width, height: frame.height };
      this.orientationHint = reconcileHint(
        this.orientationHint,
        frame.width > frame.height
      );
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
      const frame = await this.withClient(async (client) => {
        const info = (await client.accessibilityInfo({
          format: Format.NESTED,
        })) as RawAXElement[] | RawAXElement | null;
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
      const element = (await this.withClient((client) =>
        client.accessibilityInfo({
          point: DIAGNOSTIC_POINT,
          format: Format.LEGACY,
          keys: DESCRIBE_KEYS,
        })
      )) as RawAXElement | null;
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

    // Belt and braces: `withAccessibilityRecovery` has already asked
    // `shouldRecover` the same question, and says so out loud when the answer
    // is no. This guard stays for any future caller that has not.
    if (this.msSinceRecovery() < RECOVERY_COOLDOWN_MS) return false;

    this.log(
      `simulator ${this.udid} stopped answering accessibility; restarting ${BRIDGE_SERVICE}`
    );

    const startedAt = this.deps.now();
    const attempt = (async () => {
      try {
        await restartSimulatorBridge(this.deps, this.udid);
      } catch (error) {
        this.log(`bridge restart for ${this.udid} failed: ${toError(error).message}`);
        return false;
      }
      const deadline = this.deps.now() + RECOVERY_PROBE_TIMEOUT_MS;
      let recovered = false;
      do {
        await this.deps.sleep(RECOVERY_PROBE_INTERVAL_MS);
        recovered = await this.accessibilityIsAnswering();
      } while (!recovered && this.deps.now() < deadline);
      const took = Math.round((this.deps.now() - startedAt) / 1000);
      this.log(
        recovered
          ? `simulator ${this.udid} recovered ${took}s after restarting ${BRIDGE_SERVICE}`
          : `simulator ${this.udid} did not recover within ${took}s of restarting ${BRIDGE_SERVICE}`
      );
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
        // Say which "no" this is, and only for the cooldown: a device that has
        // never answered is not a recovery being refused, it is a boot in
        // progress, and the boot ladder is already narrating that. This is the
        // line whose absence would let a reader conclude the cure was never
        // wired up.
        if (answered) {
          this.log(
            `simulator ${this.udid} still not answering ` +
              `${Math.round(this.msSinceRecovery() / 1000)}s after a bridge restart; ` +
              `not restarting again`
          );
        }
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
  private async describeAll(): Promise<RawAXElement[]> {
    const read = () =>
      this.withClient(async (client) => {
        const info = await client.accessibilityInfo({ format: Format.NESTED });
        // An empty read comes back as JSON null, which must not become [null]
        // -- that reads as a one-element tree and would be returned as success.
        if (info == null) return [] as RawAXElement[];
        return (Array.isArray(info) ? info : [info]) as RawAXElement[];
      });

    const usable = (elements: RawAXElement[]) => {
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
      this.withClient(async (client) => {
        const read = async (backend?: Backend, keys?: string[]) => {
          const info = await client.accessibilityInfo({
            format: Format.NESTED,
            backend,
            keys,
          });
          if (info == null) return [] as RawAXElement[];
          return (Array.isArray(info) ? info : [info]) as RawAXElement[];
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
  private screenFrom(elements: RawAXElement[]): { width: number; height: number } {
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
      this.withClient(async (client) => {
        try {
          const found = (await client.accessibilityInfo({
            marker,
            matchKey,
            keys: DESCRIBE_KEYS,
          })) as { elements?: RawAXElement } | null;
          this.markAnswered();
          const element = found?.elements;
          if (!element) return null;
          // The companion matches an identifier by SUBSTRING, exactly as it
          // matches a label — its own refusal says "found no element whose
          // AXUniqueId contains". Measured against the pinned companion, 2026-08-17:
          // the marker "lainSwitch", strictly inside "PlainSwitch", resolves to
          // it. Contract check 11 pins this.
          //
          // An identifier lookup is the one that is supposed to be *exact* —
          // that is the whole reason it exists next to a label lookup, and what
          // `tap`'s toggle read-back relies on to re-read the control it just
          // operated rather than some other element whose identifier merely
          // contains the same text. Since the companion will not do it, it is
          // done here. The tree-walk path (`matchInTree`) has always compared
          // identifiers exactly, so this also makes the two paths agree for the
          // first time.
          if (matchKey === SearchableKey.UNIQUE_ID && element.AXUniqueId !== marker) {
            return null;
          }
          // Say what the tree would, as the point read does.
          //
          // The marker query is served by the default backend, which calls a
          // `UISwitch` a `CheckBox` where the tree calls it a `Switch`. Without
          // this, `findByIdentifier("PlainSwitch").type` was `"CheckBox"` while
          // `describeScreen` and `describePoint` both said `"Switch"` for that
          // same element — an agent branching on `type` behaving differently
          // depending on which lookup happened to answer, which is the exact
          // inconsistency `canonicalise` exists to end. Found by the e2e suite
          // against the real fixture, 2026-08-17.
          //
          // `subrole` is here to read despite not being in the requested keys:
          // the companion honours `keys` for point and whole-screen reads and
          // ignores it for marker queries, so a marker hit arrives with every
          // field regardless. `canonicalise` drops it again on the way out.
          element.type = reconcileType(element.type, element.subrole);
          return canonicalise(element);
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

    const portrait = await this.toPortrait(x, y);
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
        return await this.withClient(async (client) => {
          const element = (await client.accessibilityInfo({
            point: { x: Math.round(x), y: Math.round(y) },
            format: Format.LEGACY,
            keys: POINT_KEYS,
          })) as RawAXElement | null;
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

  // ---- orientation --------------------------------------------------------

  /**
   * Rotates the device, waits out the animation, then **detects** what the
   * interface adopted and reports both. Ports the `rotate` tool body
   * (index.ts:1454).
   *
   * Detected, not assumed. An app is free to decline an orientation — and one
   * always does: no Face ID iPhone will adopt upside-down portrait, whatever
   * its Info.plist says. Reporting the request back as though it had been
   * obeyed would leave every later coordinate wrong, silently, which is exactly
   * the failure the returned `adopted` exists to make visible.
   */
  async rotate(to: Orientation): Promise<RotateResult> {
    this.assertNotDeleted();

    const hid = HID_ORIENTATION[to as keyof typeof HID_ORIENTATION];
    if (hid === undefined) {
      // `Orientation` is an open union (DECISIONS.md #2), so a name no
      // companion has a HID event for reaches this far. A TypeError, because
      // it is a bad argument rather than anything about the simulator: there is
      // no state a host could inspect or retry, so there is nothing for a
      // typed `ErrorCode` to carry.
      throw new TypeError(
        `Unknown orientation "${to}". Expected one of: ${Object.keys(
          HID_ORIENTATION
        ).join(", ")}.`
      );
    }

    await this.withClient((client) => client.setOrientation(hid));

    // Rotation is animated, and the accessibility tree reports the old geometry
    // until it finishes. Through `deps.sleep`, so no unit test waits it out.
    await this.deps.sleep(ROTATION_SETTLE_MS);

    return { requested: to, adopted: await this.detectOrientation() };
  }

  /**
   * Probes the current orientation and refreshes this handle's hint. Ports the
   * `detect_rotation` tool body (index.ts:1516).
   *
   * The cached logical dimensions go first: a rotation swaps them, and a probe
   * that read the stale pair would compute every candidate position in the
   * space the screen just left.
   */
  async detectOrientation(): Promise<Orientation> {
    this.assertNotDeleted();

    this.screenDims = null;
    const detected = await this.probeOrientation();
    this.orientationHint = detected;
    return detected;
  }

  /**
   * Works out the exact orientation by cross-referencing a whole-screen read
   * (which reports frames in rotated logical space) against point reads (which
   * take input in portrait space). Ports `detectOrientation` (index.ts:542).
   *
   * The screen's shape narrows it to two, and no amount of reading narrows it
   * further: the two members of a pair are geometrically identical. So take
   * elements whose label appears exactly once, work out where each would be in
   * portrait space under both candidates, and ask what is actually at those two
   * points. An element that answers at exactly one of them has settled it; one
   * that answers at both, or neither, has proved nothing and the next element
   * is tried.
   *
   * Best-effort throughout — every failure degrades to the shape of the screen
   * rather than propagating, because a caller who asked to rotate is better
   * served by a good guess than by an error about a probe they never asked for.
   */
  private async probeOrientation(): Promise<OrientationHint> {
    try {
      const elements = await this.describeAll();
      const rootFrame = elements[0]?.frame;
      if (!rootFrame || !rootFrame.width || !rootFrame.height) {
        return "portrait"; // still booting or degenerate frame
      }

      const screenW = rootFrame.width;
      const screenH = rootFrame.height;
      // Typed in the hint vocabulary because that is what the transform takes,
      // and returned as the public one, which it is assignable to:
      // `candidateOrientations` answers with two of the four real orientations
      // and never with "auto", so nothing has to resolve anything here.
      const candidates = candidateOrientations(screenW > screenH);

      const probes = uniquelyLabelled(
        collectProbeCandidates(elements, screenW, screenH)
      );

      for (const probe of probes) {
        const centre = centreOf({ frame: probe.frame });
        if (!centre) continue;

        const matches: OrientationHint[] = [];
        for (const orientation of candidates) {
          // Where this element would be in the portrait space a point read
          // accepts, if the screen were in this orientation. Deliberately the
          // same transform tap and swipe use, so detection cannot drift from
          // the behaviour it is detecting for.
          const point = transformPointToPortrait(
            centre.x,
            centre.y,
            orientation,
            screenW,
            screenH
          );
          try {
            // `readPoint`, not `describePoint`: the probe has already done the
            // transform itself, and asking the public verb would transform it a
            // second time under the very hint being questioned.
            const pointElement = await this.readPoint(point.x, point.y);
            // Null is an empty point (DECISIONS.md #23), which is a perfectly
            // good "not here" — and the only answer this loop wants from a
            // candidate that is wrong.
            if (pointElement?.AXLabel === probe.label) matches.push(orientation);
          } catch {
            // probe failed, skip this position
          }
        }

        // Exactly one match = definitive answer
        if (matches.length === 1) return matches[0];
        // Both or neither matched — ambiguous, try next element
      }

      // No element settled it, so the shape of the screen is all we know.
      return candidates[0];
    } catch {
      // Detection is best-effort; degrade gracefully
      return "portrait";
    }
  }

  // ---- acting -------------------------------------------------------------

  /**
   * Tap by label or by coordinate. Two verbs under one name, because callers
   * think of them as one:
   *
   * - `{x, y}` is a literal touch at the caller's coordinates: no resolution,
   *   no verification, delivered with the 0.1s floor. Coordinates are the
   *   caller saying where, and are taken at their word. Answers
   *   `acted: "touch"` with no `element`.
   * - `{label}` is "find this thing and operate it", and the order below is the
   *   specification: resolve, refuse a disabled control, activate a toggle
   *   through accessibility (falling back to a real touch when the action API
   *   cannot reach it), refuse a hold or multi-tap aimed at a toggle, take the
   *   centre of the frame, transform it, hit-test it, and only then touch.
   *
   * Every branch of that order exists because a tap once silently did the wrong
   * thing and reported success; the reasons are on the pieces
   * (`./ax/tap.ts`'s `decideTapVerb`, `activateToggle` and the hit-test below).
   */
  async tap(target: TapTarget, opts?: TapOptions): Promise<TapResult> {
    this.assertNotDeleted();

    const count = opts?.count ?? 1;
    const durationSeconds = holdSeconds(opts?.durationSeconds);

    if (!("label" in target)) {
      const portrait = await this.toPortrait(target.x, target.y);
      await this.sendTouch(portrait, count, durationSeconds);
      return {
        acted: "touch",
        x: Math.round(target.x),
        y: Math.round(target.y),
        count,
        durationSeconds,
      };
    }

    const element = await this.findByLabel(target.label);
    if (!element) throw new ElementNotFoundError(target.label);

    switch (decideTapVerb(element, opts)) {
      case "element-disabled":
        throw new ElementDisabledError(element);
      case "toggle-needs-plain-tap":
        // Which gesture it was is the caller's own request read back: a
        // duration means a hold, and with no duration the only way to reach
        // here is a count above one.
        throw new ToggleGestureError(
          element,
          opts?.durationSeconds !== undefined ? "hold" : "multi-tap"
        );
      case "activation": {
        const activated = await this.activateToggle(element, target.label);
        // `null` means the action API could not reach this one, and a real
        // touch is the right answer for it — see `activateToggle`.
        if (activated) return activated;
        break;
      }
      case "touch":
        break;
    }

    const centre = centreOf(element);
    if (!centre) {
      throw new SimGadgetError(
        "element-unusable-frame",
        `Found an element matching "${target.label}", but it has no usable frame to aim at.`
      );
    }

    const portrait = await this.toPortrait(centre.x, centre.y);
    const point = { x: Math.round(portrait.x), y: Math.round(portrait.y) };
    // What the caller would recognise, for anything said back to them: the
    // logical centre, not the portrait pair actually sent.
    const spoken = { x: Math.round(centre.x), y: Math.round(centre.y) };

    // Check the touch will reach the element it was aimed at, before sending
    // it.
    //
    // A frame can be perfectly correct and still not be tappable at its centre:
    // an element scrolled under a toolbar, covered by a keyboard, or sitting
    // below the fold keeps its place in the tree while its centre belongs to
    // whatever is drawn on top. Measured on this project's fixture, whose
    // stepper sits under the toolbar — a tap by name on "Plain Stepper,
    // Increment" focused the *toolbar's search field*, opened the keyboard, and
    // answered "Tapped successfully". Every frame involved was correct, so no
    // amount of tree work would have caught it.
    //
    // A hit-test is ~10ms against a tap that already costs ~110ms, and it is the
    // only general defence. Refuses rather than taps, because the wrong action
    // is worse than none and the caller can still aim by coordinate.
    //
    // `readPoint`, not `describePoint`: the transform has already happened, and
    // the public verb would apply it a second time. A failure here is not
    // swallowed the way the tool body this ports swallowed it — an empty point
    // now arrives as `null` rather than as an exception (SIMGADGET_PLAN.md's
    // deliberate change 3), so all that is left to catch is a bridge that has
    // stopped answering, which is a typed error and the caller's real answer.
    const atPoint = await this.readPoint(point.x, point.y);
    if (!atPoint || !sameElement(element, atPoint)) {
      throw new TapObstructedError(element, atPoint, spoken);
    }

    await this.sendTouch(point, count, durationSeconds);
    return {
      acted: "touch",
      x: spoken.x,
      y: spoken.y,
      count,
      durationSeconds,
      element,
    };
  }

  /**
   * Flips a toggle the way VoiceOver does, and reads the state back — or
   * answers `null` when the action API cannot reach this one.
   *
   * Why this is not a touch: a switch's accessibility frame is routinely not
   * its actuating region, so no coordinate the tree can offer will hit it
   * (`decideTapVerb` carries the measurements). Activating it is a deliberate
   * step away from "synthesize a touch": `AXPress` does not hit-test, so it
   * will operate a control a finger could not reach — one under an invisible
   * overlay, say. That is the trade, and `tap({x, y})` remains a real touch for
   * callers who need that fidelity.
   */
  private async activateToggle(
    element: AXElement,
    query: string
  ): Promise<Extract<TapResult, { acted: "activation" }> | null> {
    const before = toggleValue(element);
    const name = typeof element.AXLabel === "string" ? element.AXLabel : query;

    // Prefer the identifier: the companion re-resolves the element itself, with
    // its own stricter matching, and an identifier is exact where a label is a
    // substring that may well match something else on screen. `findByLabel` has
    // already done the forgiving match — this only has to name what it found.
    const id = element.AXUniqueId;
    const useId = typeof id === "string" && id.length > 0;

    try {
      await this.withAccessibilityRecovery(() =>
        this.withClient(
          (client) =>
            client.activate(
              useId ? id : name,
              useId ? SearchableKey.UNIQUE_ID : SearchableKey.LABEL
            ),
          { exclusive: true }
        )
      );
    } catch (error) {
      // The action API cannot reach every element the tree can.
      //
      // `AccessibilityActionRequest` has no `backend` field, where the read
      // request does — so a lookup can fall back to AXBridge and an *action*
      // cannot. Anything only that backend can see is therefore findable and
      // not activatable: a switch in a toolbar or nav bar, or one inside a
      // sheet drawn by another process.
      //
      // Handing the tap back rather than failing, because this is exactly the
      // case where a coordinate genuinely works: such a switch was reachable by
      // name until toggles started being activated instead of touched, and its
      // frame was the control all along. The caller's tap then goes through the
      // ordinary path, hold and hit-test verification included, so if the centre
      // turns out not to be the control they get the honest refusal rather than
      // a touch into empty space.
      if (!isNoElementError(toError(error).message)) throw error;
      return null;
    }

    // Read it back rather than assuming it flipped — by identifier where there
    // is one, because a label is a substring and the screen has just changed.
    // An app that reports what happened in its own UI is enough to break this:
    // the fixture's status line reads "Settings Switch = on" after the toggle,
    // so a second lookup for "Settings Switch" finds that sentence rather than
    // the control, and reads back no value at all. That was a real bug, found
    // and fixed.
    const after = useId
      ? await this.findByIdentifier(id)
      : await this.findByLabel(query);

    // `after` stays undefined when there was nothing to read: the host must be
    // able to say the state could not be confirmed rather than claim success.
    return { acted: "activation", element, before, after: toggleValue(after) };
  }

  /**
   * Delivers the touches, in **portrait** coordinates.
   *
   * Exclusive, because interleaving another caller's input with a multi-tap
   * would turn a double-tap into two unrelated single taps.
   */
  private async sendTouch(
    point: { x: number; y: number },
    count: number,
    durationSeconds: number
  ): Promise<void> {
    await this.withClient(
      async (client) => {
        for (let i = 0; i < count; i++) {
          if (i > 0) await this.deps.sleep(TAP_REPEAT_GAP_MS);
          await client.tap(point.x, point.y, durationSeconds);
        }
      },
      { exclusive: true }
    );
  }

  /**
   * Types printable ASCII and newline as key events.
   *
   * The refusal is here, at the library boundary, rather than left to the idb
   * client's own — which raises an `IdbError` naming keycodes. Checking twice
   * costs a set membership per character and buys the thing design rule 2 asks
   * for: the typed error is what escapes, with the distinct offending
   * characters on it, and no caller has to read a message to find out what they
   * were. Before any event goes out, either way: half a string typed into an
   * app is not a failure a caller can undo.
   *
   * Exclusive, so another caller's taps cannot land mid-string.
   */
  async typeText(text: string): Promise<void> {
    this.assertNotDeleted();

    // Distinct, and in the order they were met: a caller who typed the same
    // emoji forty times wants to be told about the emoji, once.
    const unmapped = [...new Set(unmappedCharacters(text))];
    if (unmapped.length > 0) throw new UntypeableTextError(unmapped);

    await this.withClient((client) => client.typeText(text), {
      exclusive: true,
    });
  }

  /**
   * A swipe between two points in logical space.
   *
   * Void because there is genuinely nothing to read back: the companion acks
   * delivery and knows no more than we do about what the app made of it.
   *
   * Both endpoints go through one resolved transform, so they cannot end up in
   * different coordinate spaces (see `portraitTransform`). `delta` and
   * `durationSeconds` pass through as given — the client already substitutes 0
   * for `undefined`, and the defaults a caller sees belong to whatever host is
   * asking (DECISIONS.md #15).
   *
   * Exclusive: a swipe is a stream of events, and another caller's input
   * landing between them scrambles the gesture.
   */
  async swipe(
    from: { x: number; y: number },
    to: { x: number; y: number },
    opts?: { durationSeconds?: number; delta?: number }
  ): Promise<void> {
    this.assertNotDeleted();

    const transform = await this.portraitTransform();
    const start = transform(from.x, from.y);
    const end = transform(to.x, to.y);

    await this.withClient(
      (client) =>
        client.swipe(
          { x: Math.round(start.x), y: Math.round(start.y) },
          { x: Math.round(end.x), y: Math.round(end.y) },
          { delta: opts?.delta, duration: opts?.durationSeconds }
        ),
      { exclusive: true }
    );
  }

  /**
   * A hardware button. HOME is the only way to leave an app without launching
   * another, which is the first thing a short script needs.
   */
  async pressButton(
    button: "home" | "lock" | "side-button" | "siri" | "apple-pay",
    opts?: { durationSeconds?: number }
  ): Promise<void> {
    this.assertNotDeleted();

    const hid = HID_BUTTON[button];
    if (hid === undefined) {
      // The parameter is a closed union, so this is only reachable from
      // JavaScript. A TypeError for the same reason `rotate` throws one: it is
      // a bad argument rather than anything about the simulator, so there is no
      // state for a typed `ErrorCode` to carry.
      throw new TypeError(
        `Unknown button "${button}". Expected one of: ${Object.keys(HID_BUTTON).join(", ")}.`
      );
    }

    await this.withClient(
      (client) => client.pressButton(hid, opts?.durationSeconds),
      { exclusive: true }
    );
  }

  // ---- capture ------------------------------------------------------------

  /**
   * A screenshot of the screen, **rotated to match the interface**.
   *
   * simctl captures in physical portrait pixel orientation whatever the device
   * is doing, so a landscape capture arrives on its side; every caller of this
   * library would then have to know that and undo it. Rotating here is a
   * deliberate change from today's `screenshot` tool, which saves the raw
   * capture — the spec's `Screenshot` type mandates it, and `orientation` says
   * which way up the returned image is.
   *
   * `resizeTo: "points"` is the option `ui_view` was built out of: the image
   * comes back in the coordinate space the caller's own taps live in, which is
   * both far smaller than native pixels and directly comparable with anything
   * a describe reported.
   */
  async screenshot(opts: ScreenshotOptions = {}): Promise<Screenshot> {
    this.assertNotDeleted();

    const orientation = await this.captureOrientation();
    const resize =
      opts.resizeTo === "points"
        ? await this.portraitResizeDimensions()
        : opts.resizeTo ?? null;

    try {
      return await captureScreenshot(this.deps, this.udid, opts, { orientation, resize });
    } catch (error) {
      throw this.mapSimctlError(error);
    }
  }

  /**
   * Which way up the returned image has to be.
   *
   * The read is paid for only when the hint is `"auto"`: a hint set by a
   * rotation or a probe is authoritative and knows something the screen's shape
   * cannot say, so asking the screen could only lose the chirality that probe
   * paid for. Ports index.ts:2192.
   */
  private async captureOrientation(): Promise<Orientation> {
    const dims = this.orientationHint === "auto" ? await this.logicalDimensions() : null;
    return getEffectiveOrientation(
      this.orientationHint,
      dims?.width ?? 0,
      dims?.height ?? 0
    );
  }

  /**
   * The portrait point dimensions to resample to for `resizeTo: "points"`.
   *
   * `describe` first, because it answers from target metadata rather than from
   * the bridge (DECISIONS.md #6). The accessibility root frame is the fallback
   * — it is where these came from before, and normalising it to portrait is
   * what index.ts:2183 did — and it is also what raises the caller's real
   * problem when neither source can answer, since `screenSize()` runs the whole
   * cure ladder and throws a typed error rather than returning a shrug.
   */
  private async portraitResizeDimensions(): Promise<{ width: number; height: number }> {
    return (await this.portraitPointDimensions()) ?? pointDimensions(await this.screenSize());
  }

  /**
   * Starts recording video to `path`, and resolves once it is under way.
   *
   * One recording per handle: a second call throws rather than silently
   * replacing the first, because the process it would abandon holds the only
   * reference to a file that never gets finalized.
   */
  async startRecording(outputPath: string, opts: RecordingOptions = {}): Promise<void> {
    this.assertNotDeleted();

    if (this.recording) {
      throw new SimGadgetError(
        "recording-already-active",
        "A recording is already in progress for this simulator handle. Stop it first."
      );
    }

    // DECISIONS.md #12: `path.resolve` against the process cwd and nothing
    // more. `~/Downloads` and the default output directory are host policy.
    const absolutePath = path.resolve(outputPath);

    // Nothing may `await` between the spawn and the listeners: what the child
    // says about starting is said within milliseconds, and a listener attached
    // after it has spoken never hears it.
    const child = this.deps.spawn(
      "xcrun",
      recordingArgs({ udid: this.udid, outputPath: absolutePath, ...opts })
    );
    const started = waitForRecordingStart(this.deps, child);

    // Everything this handle owes the child is arranged here, in the same
    // window as the spawn and for the same reason the listeners are: a child
    // that says "Recording started" and then dies says the second thing
    // within milliseconds, and a handler attached after `await started` can
    // miss it entirely.
    //
    // Nothing else will ever stop this process, so the library takes
    // responsibility for it from here — see `trackRecording`.
    trackRecording(child);
    // A recording that dies on its own must not leave the handle permanently
    // refusing to start another (index.ts:2514). Guarded on identity, so a
    // late `close` from the process this one replaced cannot clear a
    // successor.
    let closed = false;
    child.on("close", () => {
      closed = true;
      if (this.recording?.child === child) this.recording = null;
    });

    try {
      await started;
    } catch (error) {
      throw this.mapSimctlError(error);
    }

    // `closed` is the other half of the same guard, and it is why attaching
    // the listener early is not enough on its own. A child that closes in the
    // window between announcing itself and this line finds nothing to clear —
    // the handle has not published it yet — and publishing it afterwards
    // would store a process that has already gone, which is exactly the state
    // that refuses every later recording until someone stops a corpse.
    if (!closed) this.recording = { child, path: absolutePath };
  }

  /**
   * Stops the recording and returns where it was written.
   *
   * The path comes from the handle rather than from the caller: `startRecording`
   * resolved it, and answering with anything else would hand back a relative
   * path the caller would have to resolve the same way to use.
   */
  async stopRecording(): Promise<{ path: string }> {
    this.assertNotDeleted();

    const active = this.recording;
    if (!active) {
      throw new SimGadgetError(
        "no-active-recording",
        "No recording is in progress for this simulator handle."
      );
    }

    // Cleared before the stop rather than after: the wait for the file to
    // finalize is a second long, and a second `stopRecording` inside it would
    // otherwise interrupt the same process twice.
    this.recording = null;
    await stopRecordingProcess(this.deps, active.child);
    return { path: active.path };
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
