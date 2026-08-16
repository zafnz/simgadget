/**
 * Simulator lifecycle: listing, creating, attaching, and the boot ladder that
 * makes "booted" and "driveable" two different, honestly-reported things.
 *
 * SIMGADGET_PLAN.md step 2. Ports `findDevice`, `findDeviceType`,
 * `findLatestRuntime`, `waitForBootStatus` and `waitUntilDriveable` from the
 * repo-root `src/index.ts` (line numbers in each function's doc comment), plus
 * the `simctl create` / `simctl boot` sequence inlined in today's
 * `start_simulator` tool body.
 *
 * Every impure piece takes a `SimulatorDeps` rather than reaching for
 * `child_process` or `Date.now()` itself, per `./internal/deps.ts` — that is
 * what lets the fake-client test layer drive `createSimulatorWith` /
 * `attachSimulatorWith` / `waitUntilDriveable` without a real simulator and
 * without waiting out a real boot.
 *
 * `createSimulator`/`attachSimulator` are frozen by SIMGADGET.md at
 * `(opts?) => Promise<Simulator>` / `(udid) => Promise<Simulator>` — no room
 * for a `deps` parameter on the public functions. Each has a `...With(deps,
 * ...)` twin that takes it, which the public function calls with `realDeps`;
 * tests reach the twin directly, the same privilege the fake `IdbClient` has
 * (SIMGADGET_PLAN.md, "The tether rule").
 */

// `ax/tree.ts`'s `AXElement` is the internal, open type ([key: string]:
// unknown); the closed public one lands in plan step 8, when `canonicalise`
// becomes the conversion point (DECISIONS.md #4). Used here only for the
// `.frame` read on a root element, which exists on both shapes.
import type { AXElement } from "./ax/tree.ts";
import {
  DeviceTypeNotFoundError,
  SimGadgetError,
  SimulatorNotFoundError,
} from "./errors.ts";
import { realDeps, type SimulatorDeps } from "./internal/deps.ts";
import { Format } from "./idb/client.ts";
import { companions } from "./idb/companionManager.ts";
import { Simulator } from "./simulator.ts";

// ---- Shared types (spec "Shared types" / the Simulator handle) -----------
//
// These are declared here, ahead of `index.ts`'s public surface (plan step
// 8), because `lifecycle.ts` needs them now. `errors.ts` already set this
// precedent for `AXElement`. `index.ts` re-exports them; it does not redefine
// them.

/**
 * `simctl`'s own device-state vocabulary, open per DECISIONS.md #2: spelled
 * `| (string & {})`, not `| string`, so the four known states stay in
 * autocomplete and error messages instead of collapsing the union, while
 * still accepting whatever `simctl` prints next (it reserves the right to
 * grow new states).
 */
export type SimulatorState =
  | "Booted"
  | "Shutdown"
  | "Booting"
  | "Shutting Down"
  | "Creating"
  | (string & {});

export interface SimInfo {
  udid: string;
  name: string;
  state: SimulatorState;
  deviceTypeIdentifier: string;
  runtimeIdentifier: string;
}

export interface ReadyResult {
  /** Did the simulator serve a usable accessibility read within budget? */
  ready: boolean;
  waitedMs: number;
  /** Was the end-of-budget bridge restart attempted? */
  recoveryTried: boolean;
  /** Did it recover after that restart? (false when it was never needed) */
  recovered: boolean;
}

export interface CreateOptions {
  /** Device-type keyword, e.g. "iPhone", "iPad", "iPhone 16 Pro". Substring
   * match against simctl devicetypes; first (newest) match wins. Default
   * "iPhone". Throws DeviceTypeNotFoundError with the available list. */
  deviceType?: string;
  /** simctl device name. Default: derived from the keyword. */
  name?: string;
  /** Boot after creating. Default true. */
  boot?: boolean;
  /** Budget for boot-and-become-driveable. Default 55_000. Only meaningful
   * with boot: true. */
  budgetMs?: number;
}

// ---- Pure extractions -----------------------------------------------------

/**
 * Flattens `xcrun simctl list devices -j`'s output into one array.
 *
 * The JSON nests devices under a bucket per runtime, keyed by the runtime's
 * own identifier (`"com.apple.CoreSimulator.SimRuntime.iOS-17-4"`) — that key
 * is the only place `runtimeIdentifier` appears, so it has to be threaded
 * through here rather than read off the device object. Ports `findDevice`
 * (index.ts:383), generalised from "search every bucket for one udid" to
 * "return every device", which is what `listSimulators()` needs too.
 */
export function parseDevices(json: unknown): SimInfo[] {
  const devices = (json as { devices?: unknown } | null)?.devices;
  if (typeof devices !== "object" || devices === null) return [];

  const result: SimInfo[] = [];
  for (const [runtimeIdentifier, bucket] of Object.entries(
    devices as Record<string, unknown>
  )) {
    if (!Array.isArray(bucket)) continue;
    for (const device of bucket) {
      if (typeof device?.udid !== "string") continue;
      result.push({
        udid: device.udid,
        name: typeof device.name === "string" ? device.name : "",
        state: typeof device.state === "string" ? device.state : "Shutdown",
        deviceTypeIdentifier:
          typeof device.deviceTypeIdentifier === "string"
            ? device.deviceTypeIdentifier
            : "",
        runtimeIdentifier,
      });
    }
  }
  return result;
}

/** One row of `xcrun simctl list devicetypes -j`'s `devicetypes` array. */
export interface DeviceTypeInfo {
  identifier: string;
  name: string;
}

/**
 * Picks a device type by substring, case-insensitively. Ports `findDeviceType`
 * (index.ts:423). **First match wins, because `simctl` lists newest devices
 * first** — `list` must not be re-sorted before this is called, or "newest"
 * silently stops being true.
 */
export function pickDeviceType(
  list: DeviceTypeInfo[],
  keyword: string
): DeviceTypeInfo {
  const lowerKeyword = keyword.toLowerCase();
  const match = list.find((dt) => dt.name.toLowerCase().includes(lowerKeyword));
  if (!match) {
    throw new DeviceTypeNotFoundError(
      keyword,
      list.map((dt) => dt.name)
    );
  }
  return match;
}

/** One row of `xcrun simctl list runtimes -j`'s `runtimes` array. */
export interface RuntimeInfo {
  identifier: string;
  name: string;
  isAvailable: boolean;
}

/**
 * Picks the latest available iOS runtime. Ports `findLatestRuntime`
 * (index.ts:452): iOS only, available only, **last entry** — `simctl` lists
 * runtimes oldest first, the opposite order from devicetypes, so this is not
 * "first match" with the names swapped, it is genuinely the other end of the
 * list.
 */
export function pickLatestRuntime(list: RuntimeInfo[]): string {
  const iosRuntimes = list.filter((r) => r.isAvailable && r.name.startsWith("iOS"));
  if (iosRuntimes.length === 0) {
    throw new SimGadgetError(
      "no-ios-runtime",
      "No available iOS runtimes found. Install one via Xcode."
    );
  }
  return iosRuntimes[iosRuntimes.length - 1].identifier;
}

/**
 * The default `simctl` device name when the caller does not supply one.
 *
 * Today's server builds `${sessionId}_${keyword}`, but a session id is a
 * *server* concept (SIMGADGET.md, "The split rule") that must not reach the
 * library — two library callers picking the same keyword would otherwise
 * collide on nothing meaningful anyway, since `simctl create` keys devices by
 * udid, not by name; the name is cosmetic. `simgadget-` prefixes it so a
 * `simctl list devices` run by a human is easy to tell apart from their own
 * simulators.
 */
export function deriveDeviceName(keyword: string, name?: string): string {
  if (name) return name;
  return `simgadget-${keyword.toLowerCase().replace(/\s+/g, "-")}`;
}

/**
 * Whether a failed-to-become-driveable boot has earned a bridge restart yet.
 *
 * Extracted out of `waitUntilDriveable`'s loop precisely because "recover
 * when the budget is nearly gone rather than at a fixed age" took a rewrite
 * to get right: a fixed threshold cannot work, because `simctl bootstatus`
 * alone has been measured anywhere from 26s to 54s. A threshold small enough
 * to fire on a fast machine fires immediately on a slow one, and one large
 * enough to be safe there is never reached before the deadline. Carving the
 * attempt out of the *end* of the budget, instead, means it is always made
 * and always has a window (`RECOVERY_TAIL_MS`) to take effect — regardless of
 * how long boot itself took.
 */
export interface BootRecoveryCheck {
  /** Milliseconds since the overall wait (`waitUntilDriveable`) started. */
  elapsed: number;
  /** The wait's total budget. */
  budget: number;
  /** Milliseconds since polling started — after `bootstatus` and the settle. */
  sincePollStart: number;
}

export function shouldAttemptBootRecovery({
  elapsed,
  budget,
  sincePollStart,
}: BootRecoveryCheck): boolean {
  const remaining = budget - elapsed;
  return remaining <= RECOVERY_TAIL_MS && sincePollStart > BRIDGE_RECOVERY_MIN_POLL_MS;
}

// ---- The boot ladder --------------------------------------------------------
//
// Every constant below is measured, not guessed; the comments are the
// evidence, ported in substance from index.ts:761-795 verbatim — this is
// exactly the code a simulator boot was once spent finding out was wrong, and
// nobody should get to "simplify" it without reading why it is what it is.

/**
 * Ceiling on the whole boot-to-driveable wait. `simctl boot` and "Booted"
 * both happen a minute or more before the accessibility bridge answers;
 * reporting success at that point hands the caller a simulator where every UI
 * call fails, blaming a fullscreen dialog that is not there. Returning
 * honestly at 55s with a udid and "poll" is strictly better than that, and a
 * healthy simulator is ready in ~40s including the boot wait — anything past
 * this is not going to be rescued by waiting a little longer.
 */
export const BOOT_READY_TIMEOUT_MS = 55_000;

/**
 * How long to leave a freshly booted simulator alone before speaking to it.
 * Well under the ~30s a healthy device takes to become driveable, so it is
 * not on the critical path; kept because it costs nothing and there is weak
 * evidence early contact is implicated in the bridge wedge, not because it is
 * known to help.
 */
export const BOOT_SETTLE_MS = 8_000;

/** The guest service that owns the accessibility bridge, and the one to
 * restart when it wedges — what `remediateSpringBoard` does inside idb. */
const BRIDGE_SERVICE = "com.apple.CoreSimulator.bridge";

/**
 * Budget for the recovery attempt and the probes after it, carved out of the
 * end of the boot wait so the attempt is always made and always has room to
 * take effect. A recovered simulator answered within ~5s in testing.
 */
export const RECOVERY_TAIL_MS = 12_000;

/**
 * Never call a device wedged before this much unsuccessful polling, however
 * little budget is left. A healthy device answers within ~5s of boot
 * completing, so this only guards against restarting the bridge on one that
 * is merely slow.
 */
export const BRIDGE_RECOVERY_MIN_POLL_MS = 8_000;

/**
 * Cap on waiting for `simctl bootstatus`, which blocks until the device
 * finishes booting and has been measured from 26s to 54s under load. Past
 * this the poll below is a better use of the remaining budget than more
 * waiting.
 */
export const BOOTSTATUS_CAP_MS = 30_000;

/** How often `waitUntilDriveable` re-probes once polling starts. Not one of
 * the five measured constants; just the loop's pace. */
const BOOT_POLL_INTERVAL_MS = 2_000;

/**
 * Restarts the guest's CoreSimulator bridge — the cure for a simulator that
 * renders, taps and answers `describe`, but never brings its accessibility
 * service up. Ports index.ts:813; see that comment for how this was verified
 * against a wedged simulator (bridge pid changed, reads worked immediately
 * after, device and apps untouched).
 */
async function restartSimulatorBridge(deps: SimulatorDeps, udid: string): Promise<void> {
  await deps.run("xcrun", ["simctl", "spawn", udid, "launchctl", "stop", BRIDGE_SERVICE]);
}

/**
 * Blocks until CoreSimulator reports the device has finished booting, or
 * `capMs` runs out. Ports `waitForBootStatus` (index.ts:1069).
 *
 * `simctl bootstatus` is documented to "monitor the specified device and
 * print boot status information until the device finishes booting" — a real
 * signal in place of a fixed sleep that would not stretch under load. It says
 * nothing about the accessibility service, which is what the settle and the
 * poll after this are for.
 *
 * Failures are swallowed: this is a way to wait well, not a precondition.
 * Uses `deps.spawn`, not `deps.run`, because it may need to kill the process
 * before it exits on its own.
 */
async function waitForBootStatus(
  deps: SimulatorDeps,
  udid: string,
  capMs: number
): Promise<void> {
  const child = deps.spawn("xcrun", ["simctl", "bootstatus", udid, "-b"]);
  try {
    await Promise.race([
      new Promise<void>((resolve) => child.on("exit", () => resolve())),
      deps.sleep(capMs),
    ]);
  } catch {
    // Older Xcode, or a device that finished before we asked. The poll below
    // is the actual readiness test either way.
  } finally {
    // Nothing downstream needs this process once we have stopped waiting on
    // it, and leaving it attached would outlive the call that started it.
    if (child.exitCode === null) child.kill();
  }
}

/**
 * Resolves once the simulator can actually be driven, or when `timeoutMs`
 * runs out. Ports `waitUntilDriveable` (index.ts:1105).
 *
 * The probe is an accessibility read, **not** `describe`: `describe` answers
 * from target metadata and starts succeeding while the bridge is still
 * silent, so it would report ready far too early. A zero-sized root frame
 * counts as not ready for the same reason.
 *
 * Never throws on a timeout — it reports one instead, via `ready: false`.
 * `createSimulator`/`boot()`/`waitReady()` depend on that: the simulator
 * exists (or is already running) either way, and a throw here would discard
 * the handle and the udid with it.
 */
export async function waitUntilDriveable(
  deps: SimulatorDeps,
  udid: string,
  timeoutMs: number = BOOT_READY_TIMEOUT_MS
): Promise<ReadyResult> {
  const started = deps.now();

  // Wait on CoreSimulator's own signal first, then leave the device alone for
  // a moment before speaking to it. See BOOT_SETTLE_MS for why the settle is
  // kept despite weak evidence.
  await waitForBootStatus(deps, udid, BOOTSTATUS_CAP_MS);
  await deps.sleep(BOOT_SETTLE_MS);

  const pollingStarted = deps.now();
  let recoveryTried = false;

  while (deps.now() - started < timeoutMs) {
    try {
      const frame = await deps.withClient(udid, async (client) => {
        const info = (await client.accessibilityInfo({
          format: Format.NESTED,
        })) as AXElement[] | AXElement | null;
        if (info == null) return null;
        const root = Array.isArray(info) ? info[0] : info;
        return root?.frame ?? null;
      });
      if (frame && frame.width && frame.height) {
        return {
          ready: true,
          waitedMs: deps.now() - started,
          recovered: recoveryTried,
          recoveryTried,
        };
      }
    } catch {
      // Expected while booting. Only the deadline, or a successful read, ends
      // this loop.
    }

    // Past the point where a healthy device would have answered, stop waiting
    // and treat it as the wedge: restart the bridge once, then keep polling.
    // Doing this here rather than only reporting it means the common failure
    // costs a caller seconds instead of a destroyed simulator.
    if (
      !recoveryTried &&
      shouldAttemptBootRecovery({
        elapsed: deps.now() - started,
        budget: timeoutMs,
        sincePollStart: deps.now() - pollingStarted,
      })
    ) {
      recoveryTried = true;
      try {
        await restartSimulatorBridge(deps, udid);
      } catch {
        // Best-effort; the poll loop is the actual readiness test.
      }
    }

    await deps.sleep(BOOT_POLL_INTERVAL_MS);
  }

  return {
    ready: false,
    waitedMs: deps.now() - started,
    recovered: false,
    recoveryTried,
  };
}

// ---- listSimulators / findDevice ------------------------------------------

/** `listSimulators()`, parameterised over `deps` for the fake-client layer. */
export async function listSimulatorsWith(deps: SimulatorDeps): Promise<SimInfo[]> {
  const { stdout } = await deps.run("xcrun", ["simctl", "list", "devices", "-j"]);
  return parseDevices(JSON.parse(stdout));
}

export function listSimulators(): Promise<SimInfo[]> {
  return listSimulatorsWith(realDeps);
}

/**
 * One device by udid, or `null` if `simctl` does not know it. Built on
 * `listSimulatorsWith` rather than a second `simctl` call, since `parseDevices`
 * already has to search every runtime bucket to answer either question.
 */
export async function findDevice(deps: SimulatorDeps, udid: string): Promise<SimInfo | null> {
  const devices = await listSimulatorsWith(deps);
  return devices.find((d) => d.udid === udid) ?? null;
}

// ---- Handle construction: the seam ----------------------------------------

/**
 * Turns the ingredients `createSimulatorWith`/`attachSimulatorWith` gather
 * (a udid, a name, the deps they were given) into the `Simulator` the spec
 * promises. Kept as one named, overridable call site — rather than a bare
 * `new Simulator(...)` buried in each procedure — because it is the exact
 * line simulator.ts's construction step needs to stay a single obvious seam:
 * whoever changes what "constructing a handle" means (e.g. a later step's
 * udid-keyed recovery registry wanting a hook at construction time) changes
 * this function and nothing that calls it.
 */
export type HandleFactory = (udid: string, name: string, deps: SimulatorDeps) => Simulator;

export const defaultHandleFactory: HandleFactory = (udid, name, deps) =>
  new Simulator(udid, name, deps);

// ---- createSimulator / attachSimulator -------------------------------------

/**
 * `createSimulator`, parameterised over `deps` and the handle factory for the
 * fake-client layer. Ports the `start_simulator` tool body's create sequence
 * (index.ts:1248-1288): devicetype → runtime → `simctl create` → (if booting)
 * `simctl boot` → `open -a Simulator.app` → `companions.reopen` → wait until
 * driveable.
 *
 * Does **not** throw on a boot that timed out (DECISIONS.md #1 / SIMGADGET.md
 * "boot()/waitReady() do not throw on timeout"): the simulator exists either
 * way, and throwing would discard the handle and the udid with it. The
 * outcome lands in the returned handle's `lastBoot` instead.
 */
export async function createSimulatorWith(
  opts: CreateOptions | undefined,
  deps: SimulatorDeps,
  makeHandle: HandleFactory = defaultHandleFactory
): Promise<Simulator> {
  const keyword = opts?.deviceType || "iPhone";
  const boot = opts?.boot ?? true;
  const budgetMs = opts?.budgetMs ?? BOOT_READY_TIMEOUT_MS;

  const { stdout: deviceTypesJson } = await deps.run("xcrun", [
    "simctl",
    "list",
    "devicetypes",
    "-j",
  ]);
  const deviceTypes: DeviceTypeInfo[] = JSON.parse(deviceTypesJson).devicetypes ?? [];
  const deviceType = pickDeviceType(deviceTypes, keyword);

  const { stdout: runtimesJson } = await deps.run("xcrun", ["simctl", "list", "runtimes", "-j"]);
  const runtimes: RuntimeInfo[] = JSON.parse(runtimesJson).runtimes ?? [];
  const runtimeIdentifier = pickLatestRuntime(runtimes);

  const deviceName = deriveDeviceName(keyword, opts?.name);

  const { stdout: udid } = await deps.run("xcrun", [
    "simctl",
    "create",
    deviceName,
    deviceType.identifier,
    runtimeIdentifier,
  ]);

  // `boot: true` (the default) both boots the device and opens Simulator.app
  // — DECISIONS.md #1, settled with the owner: `simctl boot` alone leaves no
  // window, and the MCP server may only use the public API, so if the library
  // does not do this nobody can. `boot: false` does neither, and does not
  // wait below either — CreateOptions has no separate "open the window" knob.
  if (boot) {
    await deps.run("xcrun", ["simctl", "boot", udid]);
    await deps.run("open", ["-a", "Simulator.app"]);
  }

  // A previous delete() (or today's destroy_simulator) may have blocked this
  // udid from getting a new companion; a freshly created one is fair game
  // again. This is a synchronous, in-memory operation on the process-level
  // companion registry (Set.delete), not I/O, which is why it is reached
  // directly rather than through SimulatorDeps — see the report for why this
  // step did not add it to the frozen `internal/deps.ts` instead.
  companions.reopen(udid);

  const handle = makeHandle(udid, deviceName, deps);

  if (boot) {
    const ready = await waitUntilDriveable(deps, udid, budgetMs);
    handle._recordBoot(ready);
  }

  return handle;
}

export function createSimulator(opts?: CreateOptions): Promise<Simulator> {
  return createSimulatorWith(opts, realDeps);
}

/**
 * `attachSimulator`, parameterised over `deps` and the handle factory for the
 * fake-client layer.
 *
 * Verifies the udid exists and nothing more: no probe, no boot, no claim
 * about orientation. Callers who need it driveable call `sim.waitReady()`
 * next (a later step). Still calls `companions.reopen(udid)` — today's
 * `attach_simulator` does, to clear a block a previous detach left behind —
 * for the same reason and through the same direct call as `createSimulatorWith`.
 */
export async function attachSimulatorWith(
  udid: string,
  deps: SimulatorDeps,
  makeHandle: HandleFactory = defaultHandleFactory
): Promise<Simulator> {
  const device = await findDevice(deps, udid);
  if (!device) {
    throw new SimulatorNotFoundError(udid);
  }

  companions.reopen(udid);

  return makeHandle(udid, device.name, deps);
}

export function attachSimulator(udid: string): Promise<Simulator> {
  return attachSimulatorWith(udid, realDeps);
}
