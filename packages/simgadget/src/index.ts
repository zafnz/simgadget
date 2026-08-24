/**
 * The public surface of `simgadget`, and the only thing a user can resolve: the
 * `exports` map in package.json exposes this module and nothing else, so
 * everything under `ax/`, `idb/` and `internal/` is private in the only way
 * that survives contact with users — `require("simgadget/build/idb/client.js")`
 * does not resolve, whatever the file layout looks like.
 *
 * This list is the spec's "The library API", exactly (SIMGADGET.md, which is
 * authoritative for this branch). It is also the hardest thing here to change
 * later: a name that ships is a name someone imports. Anything not named below
 * is private forever unless a human decides otherwise — in particular
 * `IdbClient` and its `Promise<unknown>` reads, `CompanionManager`, the deps
 * seam and the recovery registry, all of which are implementation and none of
 * which a caller can do anything useful with.
 *
 * Two things to know about what *is* here:
 *
 *  - `AXElement` is the closed type. `ax/tree.ts` also has an open one, which
 *    describes the free-form JSON a companion sends; `canonicalise` is the
 *    crossing, and only the closed side is published, so a caller reading
 *    `element.role` learns from the compiler that there is no such field.
 *  - `Orientation` is the four device orientations, and never `"auto"`. That is
 *    a handle's internal "nobody has told me" state and is resolved at every
 *    boundary (DECISIONS.md #3).
 */

export { listSimulators, createSimulator, attachSimulator } from "./lifecycle.ts";
export { prefetchCompanion } from "./idb/companionBinary.ts";
export { Simulator } from "./simulator.ts";

export {
  SimGadgetError,
  UnsupportedArchitectureError,
  CompanionDownloadError,
  CompanionStartError,
  SimulatorNotFoundError,
  DeviceTypeNotFoundError,
  SimulatorNotAnsweringError,
  AccessibilityUnreadableError,
  ElementNotFoundError,
  ElementDisabledError,
  TapObstructedError,
  ToggleGestureError,
  UntypeableTextError,
  type ErrorCode,
} from "./errors.ts";

export type { Frame, AXElement } from "./ax/tree.ts";
export type {
  Orientation,
  SimulatorState,
  SimInfo,
  DeviceTypeInfo,
  ReadyResult,
  CreateOptions,
  AttachOptions,
} from "./lifecycle.ts";
export type {
  HandleOptions,
  ScreenRead,
  TapTarget,
  TapOptions,
  TapResult,
  RotateResult,
} from "./simulator.ts";
export type { ScreenshotOptions, Screenshot, RecordingOptions } from "./capture.ts";
