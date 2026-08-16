/**
 * The library's error taxonomy — SIMGADGET.md, "Errors", verbatim in
 * structure.
 *
 * Two rules, both from the spec's design rules, both enforced here rather
 * than merely hoped for:
 *
 *  - **`code` is the only thing a caller may branch on.** Every failure a
 *    caller can act on carries a stable `code` from the frozen `ErrorCode`
 *    union and a typed payload. `simgadget-mcp`'s current
 *    `/found no element/i` and `no translation object` message-matching dies
 *    at this boundary — the vocabulary belongs to the idb client, and nothing
 *    upstream of it ever sees the raw wording again.
 *  - **Messages are host-agnostic** (design rule 5): no MCP tool names, no
 *    GitHub URLs, no remediation that assumes a particular host. They may
 *    name environment variables — `SIMGADGET_COMPANION_PATH` reads the same
 *    whether the caller is a three-line script or the MCP server — because
 *    that is a fact about the library, not a hosting decision.
 *
 * The design decision that makes the tests meaningful: **each subclass
 * builds its own default message from its payload**, in its own constructor,
 * rather than taking prose from call sites. That keeps the vocabulary in one
 * place instead of scattered across every `throw` site, the way the old
 * `src/index.ts` had it. An optional trailing `message` lets a caller override
 * the default when it has something more specific to say — but the default
 * must always stand on its own, because most callers will not bother.
 *
 * `AXElement` is imported from `./ax/tree.ts` rather than declared here. That
 * module's type is the internal, open one (`[key: string]: unknown`); the
 * closed public `AXElement` from the spec's "Shared types" section lands in
 * step 8, when `canonicalise` becomes the conversion point into it. Re-typing
 * the field here in the meantime would just be a second, drifting copy.
 */

import type { AXElement } from "./ax/tree.ts";

export type ErrorCode =
  // environment / companion
  | "unsupported-architecture" // not Apple Silicon; message names the arch
  | "companion-download-failed" // HTTP failure or checksum mismatch
  | "companion-start-failed" // spawned but never bound / never ready
  // simulator lifecycle
  | "simulator-not-found" // bad udid on attach, or a stale handle after delete()
  | "device-type-not-found"
  | "no-ios-runtime"
  // accessibility
  | "not-answering" // the wedge, after recovery was tried (or refused by cooldown)
  | "accessibility-unreadable" // degenerate tree that survived the full cure ladder
  // element actions
  | "element-not-found" // tap({label}) on a label nothing matches
  | "element-disabled"
  | "element-unusable-frame" // resolved, but no frame to aim at
  | "tap-obstructed" // hit-test says the touch would not reach it
  | "toggle-needs-plain-tap" // hold/multi-tap aimed at a toggle by name
  // input
  | "untypeable-text"
  // capture
  | "recording-already-active"
  | "no-active-recording"
  // apps
  | "app-bundle-not-found";

/**
 * The base of the whole taxonomy. Never thrown directly except for the five
 * codes with no payload to carry (`no-ios-runtime`, `element-unusable-frame`,
 * `recording-already-active`, `no-active-recording`, `app-bundle-not-found`)
 * — there is no fact beyond the code and a sentence for those, so a dedicated
 * subclass would exist only to be `instanceof`-checked and never destructured.
 */
export class SimGadgetError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    // `this.constructor` resolves through the prototype chain to whichever
    // subclass was actually `new`-ed, so this one line names every subclass
    // below correctly without each of them repeating it.
    this.name = this.constructor.name;
  }
}

/** A short, human-readable name for an element: its label, else its value, else its role. */
function nameOf(element: AXElement): string {
  if (typeof element.AXLabel === "string" && element.AXLabel) return element.AXLabel;
  if (element.AXValue !== undefined && element.AXValue !== null) return String(element.AXValue);
  if (typeof element.type === "string" && element.type) return element.type;
  return "element";
}

// ---- environment / companion ---------------------------------------------

/**
 * Not Apple Silicon. Deliberately carries no payload field: `arch` exists
 * only to build the message, not to be branched on — a caller who cares which
 * architecture it is running on already knows, from its own process.
 */
export class UnsupportedArchitectureError extends SimGadgetError {
  constructor(arch: string, message?: string) {
    super(
      "unsupported-architecture",
      message ??
        `Unsupported architecture "${arch}": the pinned idb_companion is built for ` +
          `Apple Silicon (arm64) only. Build one yourself for "${arch}" and point ` +
          `SIMGADGET_COMPANION_PATH at it.`
    );
  }
}

/**
 * The pinned companion could not be fetched or did not verify. Also carries
 * no payload field, for the same reason as above: `reason` is prose ("HTTP
 * 404", "checksum mismatch"), not a value a caller would match on — `code`
 * already is that value.
 */
export class CompanionDownloadError extends SimGadgetError {
  constructor(reason: string, message?: string) {
    super("companion-download-failed", message ?? `Failed to download idb_companion: ${reason}.`);
  }
}

/** The companion process spawned but never bound to its socket, or exited before it did. */
export class CompanionStartError extends SimGadgetError {
  readonly stderrTail: string[];

  constructor(stderrTail: string[], message?: string) {
    super(
      "companion-start-failed",
      message ??
        `idb_companion exited before it was ready to accept connections.` +
          (stderrTail.length > 0 ? ` Last output: ${stderrTail.join(" | ")}` : "")
    );
    this.stderrTail = stderrTail;
  }
}

// ---- simulator lifecycle ---------------------------------------------------

/** A bad udid on attach, or a handle used after `delete()` (its own or another handle's). */
export class SimulatorNotFoundError extends SimGadgetError {
  readonly udid: string;

  constructor(udid: string, message?: string) {
    super(
      "simulator-not-found",
      message ?? `No simulator with udid "${udid}" — it may never have existed, or may have been deleted.`
    );
    this.udid = udid;
  }
}

/** `deviceType` substring matched nothing in `simctl devicetypes`. */
export class DeviceTypeNotFoundError extends SimGadgetError {
  readonly keyword: string;
  readonly available: string[];

  constructor(keyword: string, available: string[], message?: string) {
    super(
      "device-type-not-found",
      message ??
        (available.length > 0
          ? `No device type matches "${keyword}". Available: ${available.join(", ")}.`
          : `No device type matches "${keyword}", and no device types are available at all.`)
    );
    this.keyword = keyword;
    this.available = available;
  }
}

// ---- accessibility ---------------------------------------------------------

/**
 * The bridge stopped answering and recovery could not be tried, or was tried
 * and did not help. `recoveryTried` distinguishes the two: `false` means a
 * restart within the last 60s already failed and the cooldown suppressed a
 * second one, `true` means one was actually attempted this time.
 */
export class SimulatorNotAnsweringError extends SimGadgetError {
  readonly recoveryTried: boolean;

  constructor(recoveryTried: boolean, message?: string) {
    super(
      "not-answering",
      message ??
        (recoveryTried
          ? "The simulator's accessibility bridge stopped answering, and restarting it did not help."
          : "The simulator's accessibility bridge stopped answering, and a restart was attempted too recently to try again yet.")
    );
    this.recoveryTried = recoveryTried;
  }
}

/**
 * A degenerate (0x0 or empty) accessibility tree that survived the full cure
 * ladder. `"booting"`: point reads do not answer either, so the device is
 * most likely still coming up. `"unrecoverable"`: point reads do answer but
 * the tree stays empty after both cures — never observed in practice, and
 * worth surfacing loudly when it is.
 */
export class AccessibilityUnreadableError extends SimGadgetError {
  readonly verdict: "booting" | "unrecoverable";

  constructor(verdict: "booting" | "unrecoverable", message?: string) {
    super(
      "accessibility-unreadable",
      message ??
        (verdict === "booting"
          ? "The simulator is not answering accessibility reads yet — it is most likely still booting."
          : "The accessibility tree came back empty even after every recovery cure was tried.")
    );
    this.verdict = verdict;
  }
}

// ---- element actions ---------------------------------------------------------

/** `findByLabel`/`findByIdentifier` return `null` for this; only an action that cannot proceed without the element throws it. */
export class ElementNotFoundError extends SimGadgetError {
  readonly query: string;

  constructor(query: string, message?: string) {
    super("element-not-found", message ?? `No element matched "${query}".`);
    this.query = query;
  }
}

/** A disabled control receives a touch and ignores it, so acting on one is refused rather than silently doing nothing. */
export class ElementDisabledError extends SimGadgetError {
  readonly element: AXElement;

  constructor(element: AXElement, message?: string) {
    super(
      "element-disabled",
      message ?? `"${nameOf(element)}" is disabled, so acting on it would do nothing.`
    );
    this.element = element;
  }
}

/**
 * The hit-test at the element's centre did not find it — covered, off
 * screen, or scrolled out of view. `obstruction` is what the hit-test found
 * instead, or `null` when nothing is there at all.
 */
export class TapObstructedError extends SimGadgetError {
  readonly element: AXElement;
  readonly obstruction: AXElement | null;
  readonly point: { x: number; y: number };

  constructor(
    element: AXElement,
    obstruction: AXElement | null,
    point: { x: number; y: number },
    message?: string
  ) {
    const what = obstruction ? `"${nameOf(obstruction)}" is there instead` : "nothing is there";
    super(
      "tap-obstructed",
      message ??
        `"${nameOf(element)}" would not receive a touch at (${point.x}, ${point.y}) — ${what}. ` +
          `It is covered, off screen, or scrolled out of view.`
    );
    this.element = element;
    this.obstruction = obstruction;
    this.point = point;
  }
}

/** A hold or multi-tap aimed at a toggle by name: its frame spans the whole row, so the centre is never the control. */
export class ToggleGestureError extends SimGadgetError {
  readonly element: AXElement;
  readonly gesture: "hold" | "multi-tap";

  constructor(element: AXElement, gesture: "hold" | "multi-tap", message?: string) {
    super(
      "toggle-needs-plain-tap",
      message ??
        `"${nameOf(element)}" is a toggle, and a ${gesture} cannot be aimed at it by name: ` +
          `its frame spans the whole row, so the centre is not the control.`
    );
    this.element = element;
    this.gesture = gesture;
  }
}

// ---- input ---------------------------------------------------------

/** Thrown before any key event goes out, listing the distinct characters the simulator's keyboard cannot type. */
export class UntypeableTextError extends SimGadgetError {
  readonly characters: string[];

  constructor(characters: string[], message?: string) {
    super(
      "untypeable-text",
      message ??
        `Cannot type ${characters.length === 1 ? "this character" : "these characters"}: ` +
          `${characters.map((c) => JSON.stringify(c)).join(", ")}.`
    );
    this.characters = characters;
  }
}
