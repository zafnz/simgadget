/**
 * Everything an agent reads, and the only pure part of the server.
 *
 * The library returns typed results and throws typed errors; an MCP tool
 * returns prose. This file is that crossing, all of it, in one place — which
 * is a deviation from the spec's four files and is here for one reason:
 * **prose left inline in seventeen tool bodies cannot be tested.** Every
 * message the old server produced needed a booted simulator, a wedged
 * accessibility bridge or a covered button to see, so none of them ever was
 * seen except by a human reading a screen. Moved out here, each is a string
 * function over a value, and the table at the bottom of `test/render.test.mts`
 * exercises all of them in microseconds.
 *
 * ## Design rule 5 runs in both directions
 *
 * The library's messages are host-agnostic: no MCP tool names, no GitHub URLs,
 * no remediation that assumes a host. **So this file is where those get
 * added**, and it is the only place in the server they may live. A `simgadget`
 * URL appearing in a library message would be the library's bug; one appearing
 * anywhere else in `packages/simgadget-mcp/src` would be this file's.
 *
 * ## What replaced `clarify()`
 *
 * The old server recognised a wedged accessibility bridge by matching idb's own
 * wording — `/No translation object/` — and rewrote it, because idb's message
 * blames coordinates and a fullscreen dialog for what is almost always a
 * simulator that is still coming up. That is the string-matching design rule 2
 * exists to kill. The library now raises `SimulatorNotAnsweringError` and
 * `AccessibilityUnreadableError{verdict}`, and the same prose is produced from
 * the type. idb's vocabulary never leaves the idb client again.
 *
 * ## The one error that stays untyped
 *
 * `SIMGADGET_COMPANION_PATH` pointing at a file that does not exist arrives as
 * an ordinary `Error` and renders through `renderError`'s fallback: its message
 * names the variable and the path, which is the whole remedy. Adding a code for
 * it is a change to the library's frozen public surface and is the owner's
 * call, not a renderer's (TODO #82). If one is ever added, it is one row in
 * `ERROR_RENDERERS` and one row in the test's table.
 */

import {
  AccessibilityUnreadableError,
  DeviceTypeNotFoundError,
  ElementDisabledError,
  ElementNotFoundError,
  SimGadgetError,
  SimulatorNotAnsweringError,
  SimulatorNotFoundError,
  TapObstructedError,
  ToggleGestureError,
  type AXElement,
  type ErrorCode,
  type Orientation,
  type ReadyResult,
  type RotateResult,
  type ScreenRead,
  type TapResult,
} from "simgadget";

// ---- the server's URLs, and nothing else's --------------------------------

/** Where a user is asked to file the failures that should not happen. */
const ISSUES_URL = "https://github.com/zafnz/simgadget/issues";

const TROUBLESHOOTING_MARKDOWN =
  "https://github.com/zafnz/simgadget/blob/main/TROUBLESHOOTING.md";
const TROUBLESHOOTING_PLAIN =
  "https://raw.githubusercontent.com/zafnz/simgadget/refs/heads/main/TROUBLESHOOTING.md";

/**
 * Both forms of the troubleshooting guide: a link for a human reading a chat
 * window, and a raw URL for a model that is going to fetch it.
 */
export function troubleshootingLink(): string {
  return `[Troubleshooting Guide](${TROUBLESHOOTING_MARKDOWN}) | [Plain Text Guide for LLMs](${TROUBLESHOOTING_PLAIN})`;
}

/** Appends the guide to a message. Every failed tool call ends this way. */
export function errorWithTroubleshooting(message: string): string {
  return `${message}\n\nFor help, see the ${troubleshootingLink()}`;
}

// ---- small shared vocabulary ----------------------------------------------

/**
 * Coerces anything a `catch` can receive into an `Error`. JavaScript permits
 * throwing a string, a number or `undefined`, and a server that crashes while
 * reporting a crash is the worst possible failure mode.
 */
export function toError(input: unknown): Error {
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

/** A short, human-readable name for an element: label, else value, else role. */
function nameOf(element: AXElement, fallback?: string): string {
  if (typeof element.AXLabel === "string" && element.AXLabel) return element.AXLabel;
  if (fallback !== undefined) return fallback;
  if (element.AXValue !== undefined && element.AXValue !== null) return String(element.AXValue);
  if (element.type) return element.type;
  return "element";
}

/**
 * An element's rectangle, for an error message a caller has to act on.
 * Rounded, because a caller reading this is about to type the numbers into
 * `ui_tap {x, y}` and four decimal places help nobody.
 */
export function describeFrame(element: AXElement): string {
  const frame = element.frame;
  if (!frame) return "no usable position";
  const round = (n: number) => Math.round(n);
  return `{x:${round(frame.x)} y:${round(frame.y)} w:${round(frame.width)} h:${round(frame.height)}}`;
}

/** A toggle's `AXValue` as a word. Anything unrecognised is shown as it came. */
function toggleState(value: unknown): string {
  return value === "1" || value === 1
    ? "on"
    : value === "0" || value === 0
      ? "off"
      : `${value}`;
}

/** Seconds, as every "waited N s" message in this server spells them. */
function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

// ---- errors ----------------------------------------------------------------

/**
 * What the renderer may know beyond the error itself.
 *
 * Deliberately tiny. Two codes named the MCP session in the old server's
 * wording and the library has no concept of one, so it is passed in rather
 * than smuggled into a library payload where it does not belong.
 */
export interface RenderContext {
  /** The MCP session id the failing tool call named. */
  sessionId?: string;
  /** The label a caller asked for, when a tool resolved an element by name. */
  label?: string;
}

type Renderer = (error: SimGadgetError, context: RenderContext) => string;

/**
 * One rendering per `ErrorCode`, and the reason this file exists.
 *
 * **`Record<ErrorCode, Renderer>` is the whole enforcement mechanism.** Add a
 * code to the library's union and this object stops compiling until it has a
 * row; `npm run typecheck` is part of green at every commit, so a code cannot
 * ship unrendered. The test walks the same object at runtime and asserts each
 * row produces something, which catches the other half — a row that exists but
 * returns nothing useful.
 *
 * Each renderer narrows with `instanceof` and falls back to `error.message`.
 * That is not defensive padding: the library genuinely throws a bare
 * `SimGadgetError` for the five codes with no payload, and a payload class
 * arriving where its code did not is a bug worth surviving rather than
 * crashing on.
 */
const ERROR_RENDERERS: Record<ErrorCode, Renderer> = {
  // ---- environment / companion ----
  //
  // All three carry messages written for exactly this purpose and naming
  // `SIMGADGET_COMPANION_PATH` where that is the remedy. Nothing to add: the
  // troubleshooting link `handleToolError` appends is the host's contribution.
  "unsupported-architecture": (error) => error.message,
  "companion-download-failed": (error) => error.message,
  "companion-start-failed": (error) => error.message,

  // ---- simulator lifecycle ----

  /**
   * A bad udid on `attach_simulator`, or a session whose simulator was deleted
   * out from under it — including by another agent that guessed the same
   * session id. The library cannot name a tool; this is the row where the
   * remedy is entirely about tools.
   */
  "simulator-not-found": (error, context) => {
    const base =
      error instanceof SimulatorNotFoundError
        ? `No simulator found with UDID "${error.udid}".`
        : error.message;
    return context.sessionId !== undefined
      ? `${base} Session "${context.sessionId}" can no longer use it — call destroy_simulator, then start_simulator for a fresh one.`
      : base;
  },

  /**
   * Today's wording (index.ts:439), rebuilt from the payload rather than from
   * a message the library composed — which is what payloads are for. The
   * nothing-available case falls through to the library's own sentence, since
   * "Available types: " followed by nothing is not an answer.
   */
  "device-type-not-found": (error) =>
    error instanceof DeviceTypeNotFoundError && error.available.length > 0
      ? `No device type found matching "${error.keyword}". Available types: ${error.available.join(", ")}`
      : error.message,

  "no-ios-runtime": (error) => error.message,

  // ---- accessibility ----

  /**
   * The wedge, and the message `clarify()` used to produce by matching idb's
   * wording. The opening is verbatim from index.ts:723; only the second half
   * branches, because the old text asserted that a restart had been tried and
   * failed even in the case where the cooldown had refused to try one — which
   * sent readers looking for a restart that never happened.
   */
  "not-answering": (error) => {
    const opening =
      "The simulator is not answering accessibility requests. It is usually " +
      "still booting — wait a few seconds and try again; a fresh simulator can " +
      "take up to 90 seconds.";
    const tried =
      error instanceof SimulatorNotAnsweringError ? error.recoveryTried : true;
    return tried
      ? `${opening} If the simulator was working a moment ago, its accessibility ` +
          `service has wedged; restarting it was already attempted and did not help, ` +
          `so retrying immediately is unlikely to either.`
      : `${opening} If the simulator was working a moment ago, its accessibility ` +
          `service has wedged; a restart was attempted too recently to try again ` +
          `yet, so wait a few seconds before retrying.`;
  },

  /**
   * `diagnoseEmptyAccessibilityTree` (index.ts:637), split by verdict. The
   * "unrecoverable" branch is the one place a tool response carries the issue
   * URL: the bridge restart has fixed this in every case ever observed, so a
   * simulator that survives it is something nobody has seen and the report is
   * worth more than the retry.
   */
  "accessibility-unreadable": (error) => {
    const verdict =
      error instanceof AccessibilityUnreadableError ? error.verdict : "booting";
    if (verdict === "booting") {
      return "Simulator is still booting. Wait a few seconds and try again.";
    }
    return (
      "The simulator is booted and answers point queries, but its accessibility " +
      "tree is empty, and restarting both idb_companion and the simulator bridge " +
      "failed to recover it. That is not expected: the bridge restart fixes this " +
      "in every case seen so far. Please ask the user to file a bug at " +
      `${ISSUES_URL} with the simulator ` +
      "UDID and this message. To carry on meanwhile, call destroy_simulator then " +
      "start_simulator — this creates a fresh simulator, so any installed app must " +
      "be reinstalled."
    );
  },

  // ---- element actions ----

  /** index.ts:1814, including the pointer at the tool that answers "what *is*
   * on screen" — which the library, having no tools, cannot give. */
  "element-not-found": (error, context) => {
    const query =
      error instanceof ElementNotFoundError ? error.query : (context.label ?? "");
    return `No element found whose label contains "${query}". Use ui_describe_all to see what is on screen.`;
  },

  /** index.ts:1826. The frame is in the message because the remedy is often
   * "scroll, or tap the coordinate", and both need the rectangle. */
  "element-disabled": (error, context) =>
    error instanceof ElementDisabledError
      ? `"${nameOf(error.element, context.label)}" is disabled, so tapping it would do nothing. ` +
        `It is at ${describeFrame(error.element)}.`
      : error.message,

  /** index.ts:1855. */
  "element-unusable-frame": (error) => error.message,

  /** index.ts:1928 — the hit-test refusal, which is the single most useful
   * thing this server says. It names where the element is, what is there
   * instead, and the two ways out. */
  "tap-obstructed": (error, context) => {
    if (!(error instanceof TapObstructedError)) return error.message;
    const name = nameOf(error.element, context.label);
    const obstruction = error.obstruction
      ? `"${nameOf(error.obstruction)}" is there instead`
      : `nothing is there`;
    return (
      `"${name}" is at ${describeFrame(error.element)}, but ${obstruction}, ` +
      `so a tap at its centre (${Math.round(error.point.x)}, ${Math.round(error.point.y)}) would not reach it — it is ` +
      `covered, off screen, or scrolled out of view. Scroll it into view, or ` +
      `read its real position from ui_view and use ui_tap {x, y}.`
    );
  },

  /** index.ts:1842. The remedy names the argument to drop, which differs
   * between the two gestures — so it is built from the payload, not chosen by
   * whoever wrote the throw. */
  "toggle-needs-plain-tap": (error, context) => {
    if (!(error instanceof ToggleGestureError)) return error.message;
    const name = nameOf(error.element, context.label);
    const gesture = error.gesture === "hold" ? "a hold" : "a multi-tap";
    const argument = error.gesture === "hold" ? "duration" : "count";
    return (
      `"${name}" is a toggle, and ${gesture} ` +
      `cannot be delivered to one by name: its frame spans the whole row, so the ` +
      `centre is not the control. Call ui_tap {label} with no ${argument} ` +
      `to switch it, or read the control's position from ui_view and use ui_tap {x, y}.`
    );
  },

  // ---- input ----

  /** The library lists the characters; that is the whole answer. */
  "untypeable-text": (error) => error.message,

  // ---- capture ----

  "recording-already-active": (error, context) =>
    context.sessionId !== undefined
      ? `A recording is already in progress for session "${context.sessionId}". Call stop_recording first.`
      : error.message,

  /** index.ts:2540's wording, which named the session and should keep doing so
   * — an agent driving several sessions needs to know which one it got wrong. */
  "no-active-recording": (error, context) =>
    context.sessionId !== undefined
      ? `No active recording for session "${context.sessionId}".`
      : error.message,

  // ---- apps ----

  /** index.ts:2589's wording exactly, which the library happens to share. */
  "app-bundle-not-found": (error) => error.message,
};

/**
 * A failure as an agent should read it.
 *
 * A typed error renders through its row above. Anything else — an `Error` from
 * `simctl`, a `SIMGADGET_COMPANION_PATH` that points at nothing, a bug in this
 * server — renders as its own message, which is what the old `handleToolError`
 * did for everything. The troubleshooting link is *not* added here: it belongs
 * to the tool call, not to the error, and `handleToolError` adds it once.
 */
export function renderError(error: unknown, context: RenderContext = {}): string {
  if (error instanceof SimGadgetError) {
    const renderer = ERROR_RENDERERS[error.code as ErrorCode];
    // A code outside the union can only arrive from a library newer than this
    // server. Its own message beats a crash or the string "undefined".
    if (renderer) return renderer(error, context);
  }
  return toError(error).message;
}

/** Every `ErrorCode` this renderer knows, for the test that walks them all. */
export function renderedErrorCodes(): ErrorCode[] {
  return Object.keys(ERROR_RENDERERS) as ErrorCode[];
}

// ---- the MCP result shapes -------------------------------------------------

/**
 * A tool result carrying one block of text. Structural, so `render.ts` stays
 * free of the MCP SDK and testable without it; the SDK accepts it as-is.
 *
 * **A type alias and not an `interface`, and that is load-bearing.** The SDK's
 * `CallToolResult` carries an index signature (`[x: string]: unknown`, from the
 * Zod schema it is inferred from), and TypeScript gives an implicit index
 * signature to a type alias but never to an interface. Declared as interfaces
 * these are rejected where a tool handler returns them — which is every tool
 * body in `tools.ts` — with an error about a missing index signature that
 * sounds like a problem with the SDK and is not.
 */
export type TextResult = {
  isError: false;
  content: { type: "text"; text: string }[];
};

/** A failed tool call. Same shape, same reason for being a type alias. */
export type ErrorResult = {
  isError: true;
  content: { type: "text"; text: string }[];
};

/** Wraps a string as a successful tool result. */
export function textResult(text: string): TextResult {
  return { isError: false, content: [{ type: "text" as const, text }] };
}

/**
 * Runs a tool body, turning any throw into an error result an agent can read:
 * `"<what was being attempted>: <why it failed>"`, then the troubleshooting
 * guide.
 *
 * The prefix matters more than it looks. An agent sees a tool result without
 * necessarily remembering which call produced it, and "No element matched" is
 * a different problem depending on whether the tool was tapping or finding.
 */
export async function handleToolError<T>(
  errorPrefix: string,
  fn: () => Promise<T>,
  context: RenderContext = {}
): Promise<T | ErrorResult> {
  try {
    return await fn();
  } catch (error) {
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: errorWithTroubleshooting(`${errorPrefix}: ${renderError(error, context)}`),
        },
      ],
    };
  }
}

// ---- responses -------------------------------------------------------------
//
// One function per thing a tool can say. Every string below is the old
// server's, verbatim where the facts to build it survived the port — these are
// what an agent reads on the success path, and a tidied sentence is a
// behaviour change wearing a typo fix's clothes.

/** `start_simulator`, where the session already had a booted simulator. */
export function renderResumed(sessionId: string, name: string, udid: string): string {
  return `Resumed existing simulator for session "${sessionId}": "${name}" (${udid})`;
}

/** `start_simulator`'s concurrency refusal (index.ts:1242). */
export function renderAlreadyStarting(sessionId: string): string {
  return `A simulator is already being created for session "${sessionId}". Wait for it to finish.`;
}

/** `attach_simulator` onto a session that already has one (index.ts:1385). */
export function renderAlreadyAttached(
  sessionId: string,
  name: string,
  udid: string
): string {
  return `Session "${sessionId}" is already attached to simulator "${name}" (${udid}). Call destroy_simulator first.`;
}

/** `attach_simulator` onto a simulator that exists but is not booted. */
export function renderNotBooted(name: string, udid: string, state: string): string {
  return `Simulator "${name}" (${udid}) is not booted (state: ${state}).`;
}

/**
 * `start_simulator`, after a create.
 *
 * `deviceTypeName` is the friendly device-type name ("iPhone 16 Pro"), which
 * the old server had to hand from its own `findDeviceType` and which
 * `createSimulator` resolves internally without handing back — see
 * SIMGADGET_PLAN_SERVER.md's open item. Passed in so this renderer is complete
 * either way; agent C decides where it comes from.
 */
export function renderStarted(args: {
  deviceName: string;
  deviceTypeName: string;
  udid: string;
  boot: ReadyResult;
}): string {
  const { deviceName, deviceTypeName, udid, boot } = args;
  const waited = seconds(boot.waitedMs);

  if (boot.ready) {
    return (
      `Simulator started: "${deviceName}" (${deviceTypeName}, ${udid}). Ready after ${waited}s.` +
      (boot.recovered
        ? " Its accessibility service had to be recovered by restarting the simulator bridge."
        : "")
    );
  }

  return (
    `Simulator created and booting: "${deviceName}" (${deviceTypeName}, ${udid}), but it has not ` +
    `answered an accessibility read after ${waited}s. ` +
    (boot.recoveryTried
      ? `Its accessibility bridge was restarted and it still had not answered by then. ` +
        `Poll ui_view: a simulator that was merely slow — which is usual when several are ` +
        `booting on one machine — answers within a few more seconds. If it is still silent ` +
        `after that, it is the wedge described at ${ISSUES_URL}, and worth reporting with ` +
        `the UDID and this message; call destroy_simulator and start_simulator to start over.`
      : `Poll ui_view until it returns a screenshot.`)
  );
}

/** `attach_simulator`, after the readiness wait. */
export function renderAttached(args: {
  name: string;
  udid: string;
  boot: ReadyResult;
}): string {
  const { name, udid, boot } = args;
  if (boot.ready) return `Attached to simulator: "${name}" (${udid})`;

  return (
    `Attached to simulator: "${name}" (${udid}), but it has not answered an ` +
    `accessibility read after ${seconds(boot.waitedMs)}s. ` +
    (boot.recoveryTried
      ? `Its accessibility bridge was restarted and it still had not answered by then. Poll ` +
        `ui_view: one that was merely slow answers within a few more seconds. If it stays ` +
        `silent, it is the wedge described at ${ISSUES_URL}, and worth reporting with the ` +
        `UDID and this message.`
      : `Poll ui_view until it returns a screenshot.`)
  );
}

/**
 * `destroy_simulator`. The two answers are genuinely different events, and
 * saying so is the only signal an agent gets that a simulator it did not
 * create is still running: an attached session detaches, it does not delete.
 */
export function renderDestroyed(name: string, udid: string, owned: boolean): string {
  return owned
    ? `Simulator destroyed: "${name}" (${udid})`
    : `Detached from simulator: "${name}" (${udid})`;
}

/**
 * `rotate`. The interface is read back rather than assumed, so the two answers
 * are "it did what you asked" and "it did something else, and here is why" —
 * the second is not an error, because the coordinates now follow the adopted
 * orientation either way and that is the fact the caller needs.
 */
export function renderRotate(sessionId: string, result: RotateResult): string {
  if (result.adopted === result.requested) {
    return `Rotated to "${result.adopted}" for session "${sessionId}".`;
  }

  const why =
    result.requested === "upside_down"
      ? " An iPhone with Face ID never gives an app an upside-down interface, so this is expected there; use an iPad if you need that orientation."
      : " The app may not support that orientation.";

  return (
    `Asked the device to rotate to "${result.requested}", but the interface is "${result.adopted}".` +
    why +
    ` Coordinates now follow "${result.adopted}".`
  );
}

/** `detect_rotation`. */
export function renderDetectedOrientation(
  sessionId: string,
  orientation: Orientation
): string {
  return `Detected orientation: "${orientation}" for session "${sessionId}".`;
}

/**
 * `ui_describe_all`. The elements only — not the `screen` rectangle beside
 * them in a `ScreenRead`, which is the root element's frame said twice, and
 * this payload is read by a model on every call.
 */
export function renderScreen(read: ScreenRead): string {
  return JSON.stringify(read.elements);
}

/**
 * `ui_find`, and `ui_describe_point`, both of which answer with one element or
 * with nothing. `null` is a normal answer for a point read — empty space is
 * not a failure — and JSON `null` is how the old server said so.
 */
export function renderElement(element: AXElement | null): string {
  return JSON.stringify(element);
}

/** `ui_find` when nothing matched: an answer, not an error. */
export function renderNoElementFound(label: string): string {
  return `No element found whose label contains "${label}". Use ui_describe_all to see what is on screen.`;
}

/**
 * `ui_tap`, over both of the things a tap can be.
 *
 * A synthesized touch names *what* it hit, not merely that it hit something:
 * matching is a substring and the first hit wins, so a status line reading
 * "Settings Switch = on" has outranked the switch it was describing. An
 * activation names the state it read back, because the cost of this whole
 * class of bug has been silent success.
 */
export function renderTap(result: TapResult, label?: string): string {
  if (result.acted === "touch") {
    const what = result.element
      ? ` "${result.element.AXLabel ?? result.element.AXValue ?? label}"` +
        (result.element.type ? ` (${result.element.type})` : "")
      : "";
    return result.count > 1
      ? `Tapped${what} ${result.count} times at (${Math.round(result.x)}, ${Math.round(result.y)}).`
      : `Tapped${what} at (${Math.round(result.x)}, ${Math.round(result.y)}).`;
  }

  const name = nameOf(result.element, label);

  if (result.after === undefined || result.after === null) {
    return `Activated ${name}, but could not read its state back to confirm it changed.`;
  }

  if (result.after === result.before) {
    return (
      `Activated ${name} through accessibility, but it is still ${toggleState(result.after)}. ` +
      `Most often it is scrolled out of view — activation does not take on an ` +
      `element that is not on screen, which is measurable and is what this ` +
      `read-back is for. Scroll it into view and try again. Otherwise the ` +
      `control may be disabled, or may not respond to activation, in which ` +
      `case read the switch's position from ui_view and tap it with ` +
      `ui_tap {x, y}.`
    );
  }

  return `Toggled ${name} ${toggleState(result.before)} -> ${toggleState(result.after)}.`;
}

/** `ui_type`. */
export function renderTyped(): string {
  return "Typed successfully";
}

/** `ui_swipe`. */
export function renderSwiped(): string {
  return "Swiped successfully";
}

/** The text block that accompanies `ui_view`'s image. */
export function renderScreenshotCaptured(): string {
  return "Screenshot captured";
}

/**
 * `screenshot`.
 *
 * The old server echoed simctl's own line back, which it read off *stderr*
 * because simctl writes it there on success. The library returns a
 * `Screenshot` and does not hand that line back, so the server composes it —
 * from the absolute path it resolved, which is strictly better than simctl's
 * copy of the same path.
 */
export function renderScreenshotSaved(absolutePath: string): string {
  return `Wrote screenshot to: ${absolutePath}`;
}

/** `record_video`. Names the tool that ends it, because an agent that starts a
 * recording and forgets leaves a process writing to a disk. */
export function renderRecordingStarted(absolutePath: string): string {
  return `Recording started. The video will be saved to: ${absolutePath}\nTo stop recording, use the stop_recording command.`;
}

/** `stop_recording`. */
export function renderRecordingStopped(): string {
  return "Recording stopped successfully.";
}

/** `install_app`. */
export function renderAppInstalled(absolutePath: string): string {
  return `App installed successfully from: ${absolutePath}`;
}

/** `launch_app`. The pid is worth saying when there is one — it is what a
 * caller needs to attach a debugger or read a log. */
export function renderAppLaunched(bundleId: string, pid: number | null): string {
  return pid !== null
    ? `App ${bundleId} launched successfully with PID: ${pid}`
    : `App ${bundleId} launched successfully`;
}

/** `getManagedSim`'s refusal, for a session that was never started. */
export function renderNoSession(sessionId: string): string {
  return `No simulator is running for session "${sessionId}". Call start_simulator first.`;
}
