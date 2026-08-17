/**
 * A scriptable stand-in for the slice of `IdbClient` the library uses:
 * `accessibilityInfo`, in its three shapes (a whole-screen tree, a server-side
 * marker query, a point read), plus `describe`, `setOrientation`, and the input
 * verbs `activate`, `tap`, `typeText`, `swipe` and `pressButton`.
 *
 * **The tether rule (SIMGADGET_PLAN.md) binds this file absolutely.** It
 * encodes our beliefs about somebody else's undocumented binary, and every one
 * of them is checked against the real companion by
 * `scripts/check-companion-contract.mjs`. Nothing here may claim a behaviour
 * that is not on that list; an untethered fake drifts into fiction and the unit
 * tests start defending a companion that does not exist, which is worse than no
 * test at all. What is claimed, and where it is checked:
 *
 *  - a marker matches a **substring** of the key it is given (check 1) and
 *    resolves to the **first** hit (check 2);
 *  - a marker answers with `{elements: <one element>}`, never a collection
 *    (check 3);
 *  - the default backend cannot see toolbar contents that AXBridge can
 *    (check 4) — modelled by letting a test give AXBridge a different tree;
 *  - a point read **hit-tests** and is cheap (check 5);
 *  - an **absent marker** fails with "found no element" (check 7);
 *  - a **point with nothing on it** fails with "no translation object", the
 *    same wording a wedged bridge produces (check 8) — which is the entire
 *    reason `describePoint` disambiguates by asking for the screen;
 *  - a marker query at depth 0 searches only the root (check 10) — the library
 *    never sends one, so this fake never has to model it;
 *  - `describe()` reports screen dimensions in **both pixels and points**
 *    (check 9), which is where the coordinate contract's cached portrait point
 *    dimensions come from;
 *  - `activate()` operates a switch **without a touch** (check 6), which is the
 *    entire basis for routing a plain tap on a toggle through the action API.
 *
 * `setOrientation`, `tap`, `typeText`, `swipe` and `pressButton` claim nothing
 * at all — they record what was asked and return. That is the tether rule being
 * satisfied rather than dodged: whether the interface obeys a rotation, or an
 * app notices a touch, is the app's decision and iOS's, which is precisely why
 * `rotate()` reads the orientation back and `tap()` hit-tests before it sends
 * instead of trusting either. A fake that made the screen turn or a control
 * actuate would be asserting the one thing the real binary does not promise.
 * Tests script what the screen looks like afterwards themselves.
 *
 * `typeText` deliberately does **not** re-implement the real client's own
 * refusal of unmappable characters. The library refuses first, at its own
 * boundary, and a fake that refused too would let that test pass on either
 * layer's behaviour — the recorded call is the only thing that can prove no
 * event went out.
 *
 * **One belief here is not pinned by any contract check, and is flagged rather
 * than hidden** (the same treatment DECISIONS.md #24 gives the `UNIQUE_ID`
 * match): that `accessibility_action` reports an element it cannot reach with
 * idb's "found no element" wording, the way an absent *marker query* does
 * (check 7). `tap()`'s fall-back-to-a-real-touch path depends on it, and it is
 * the wording the repo-root server has matched in production since the toggle
 * path was written. The fake models it only where a test asks for it — the
 * handler raises `noElementError` itself — so the assumption is visible at the
 * point it is used. A check for it belongs with plan step 10's other four.
 *
 * Reached by importing `../src/simulator.ts` directly, which is a privilege of
 * living inside the package: the `exports` map makes the seam unresolvable to
 * any user.
 */

import type { AXElement } from "../../src/ax/tree.ts";
import {
  Backend,
  Button,
  Format,
  OrientationType,
  SearchableKey,
} from "../../src/idb/client.ts";

/** One accessibility read, as the fake saw it. */
export interface AccessibilityCall {
  kind: "screen" | "marker" | "point";
  backend?: Backend;
  format?: Format;
  marker?: string;
  matchKey?: SearchableKey;
  point?: { x: number; y: number };
  keys?: string[];
}

/** The whole-screen read's answer: a tree, a single root, or JSON `null`. */
export type ScreenAnswer = AXElement[] | AXElement | null;

export interface FakeIdbOptions {
  /**
   * Answers a whole-screen read. Receives the backend so a test can make
   * AXBridge richer than the default one (contract check 4). Throw to model a
   * failure — `wedgeError()` for a bridge that is not answering. Defaults to a
   * healthy 390x844 root.
   */
  screen?: (backend: Backend | undefined, call: AccessibilityCall) => ScreenAnswer;
  /**
   * Answers a marker query. Return `null` for "no such element" and the fake
   * raises idb's own "found no element" wording (check 7) rather than returning
   * an empty result, because that is what the companion does. Defaults to
   * absent.
   */
  marker?: (
    marker: string,
    matchKey: SearchableKey | undefined,
    backend: Backend | undefined
  ) => AXElement | null;
  /**
   * Answers a point read. Return `null` for "nothing there" and the fake raises
   * "no translation object" (check 8). Defaults to nothing there.
   */
  point?: (x: number, y: number) => AXElement | null;
  /**
   * Answers `describe()`. Defaults to a 390x844-point screen at 3x. Return
   * `screenDimensions: undefined` to model a companion that answers without
   * them — the one case the library has to tolerate without a typed error.
   */
  describe?: () => FakeTargetDescription;
  /**
   * Answers `activate()`. Defaults to succeeding silently, which is what
   * check 6 pins: the action operates the control and reports nothing about it.
   * Throw `noElementError(marker)` to model the element the action API cannot
   * reach — see this file's header for why that wording is an unpinned belief.
   */
  activate?: (marker: string, matchKey: SearchableKey) => void;
}

/** The slice of `TargetDescription` the library reads. */
export interface FakeTargetDescription {
  screenDimensions?: {
    width: number;
    height: number;
    density: number;
    widthPoints: number;
    heightPoints: number;
  };
}

/**
 * A `describe()` answer for a device of this many portrait points, reported in
 * both units the way contract check 9 pins.
 */
export function targetDescription(
  widthPoints: number,
  heightPoints: number,
  density = 3
): FakeTargetDescription {
  return {
    screenDimensions: {
      width: widthPoints * density,
      height: heightPoints * density,
      density,
      widthPoints,
      heightPoints,
    },
  };
}

/**
 * idb's wording for a read the accessibility bridge could not serve, in full.
 * Ambiguous by design on the real binary: the same text means "the bridge is
 * wedged" and "that point is empty" (BOOT_BUG.md, contract check 8).
 */
export function wedgeError(): Error {
  return new Error(
    "INTERNAL: No translation object returned for simulator. This means you have " +
      "likely specified a point onscreen that is invalid or invisible due to a " +
      "fullscreen dialog"
  );
}

/** idb's wording for a marker query that matched nothing (contract check 7). */
export function noElementError(marker: string): Error {
  return new Error(`found no element matching ${marker}`);
}

/** A healthy root frame the way a NESTED read answers it. */
export function screenTree(
  width: number,
  height: number,
  children: AXElement[] = []
): AXElement[] {
  return [
    {
      type: "Application",
      frame: { x: 0, y: 0, width, height },
      ...(children.length ? { children } : {}),
    },
  ];
}

/** The 0x0 root a wedged companion serves for a perfectly healthy simulator. */
export function degenerateTree(): AXElement[] {
  return [{ type: "Application", frame: { x: 0, y: 0, width: 0, height: 0 } }];
}

/**
 * Answers in order, the last one repeating forever. The ladder tests are all
 * "this read, then that read", and a counter in every test is noise.
 */
export function inOrder<T>(...answers: Array<T | Error>): () => T {
  let index = 0;
  return () => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index++;
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

/**
 * Matches a marker against a flat list of elements the way the companion does:
 * substring against the chosen key, first hit wins (checks 1 and 2).
 */
export function markerIn(elements: AXElement[]) {
  return (marker: string, matchKey: SearchableKey | undefined): AXElement | null => {
    const key = matchKey === SearchableKey.UNIQUE_ID ? "AXUniqueId" : "AXLabel";
    return (
      elements.find((element) => {
        const value = element[key];
        return typeof value === "string" && value.includes(marker);
      }) ?? null
    );
  };
}

export class FakeIdbClient {
  /** Every read, in order, for a test that needs to assert the ladder within
   * one method (`findByLabel`'s marker → identifier → tree, say). Ordering
   * *across* kinds of dep call is `FakeDeps.calls.order`'s job. */
  readonly calls: AccessibilityCall[] = [];

  /** Every `describe()`, so a test can prove the portrait point dimensions are
   * fetched once and then cached forever. */
  describes = 0;

  /** Every orientation asked for, in order. What the *screen* then looks like
   * is the test's to script — see this file's header. */
  readonly orientations: OrientationType[] = [];

  /** Every `activate()`, in order, with the key it was matched on — which is
   * the assertion "activation goes by identifier where there is one" is made
   * against. */
  readonly activations: { marker: string; matchKey: SearchableKey }[] = [];

  /** Every touch, in order: the portrait-space point and the hold. */
  readonly taps: { x: number; y: number; duration?: number }[] = [];

  /** Every string handed to `typeText`. Empty is the proof that a refusal
   * happened before any event went out. */
  readonly typed: string[] = [];

  readonly swipes: {
    start: { x: number; y: number };
    end: { x: number; y: number };
    options: { delta?: number; duration?: number };
  }[] = [];

  readonly buttons: { button: Button; duration?: number }[] = [];

  constructor(private readonly options: FakeIdbOptions = {}) {}

  async describe(): Promise<FakeTargetDescription> {
    this.describes++;
    return (this.options.describe ?? (() => targetDescription(390, 844)))();
  }

  async setOrientation(orientation: OrientationType): Promise<void> {
    this.orientations.push(orientation);
  }

  async activate(marker: string, matchKey: SearchableKey): Promise<void> {
    this.activations.push({ marker, matchKey });
    this.options.activate?.(marker, matchKey);
  }

  async tap(x: number, y: number, duration?: number): Promise<void> {
    this.taps.push({ x, y, duration });
  }

  async typeText(text: string): Promise<void> {
    this.typed.push(text);
  }

  async swipe(
    start: { x: number; y: number },
    end: { x: number; y: number },
    options: { delta?: number; duration?: number } = {}
  ): Promise<void> {
    this.swipes.push({ start, end, options });
  }

  async pressButton(button: Button, duration?: number): Promise<void> {
    this.buttons.push({ button, duration });
  }

  async accessibilityInfo(query: unknown): Promise<unknown> {
    const q = (query ?? {}) as {
      point?: { x: number; y: number };
      marker?: string;
      matchKey?: SearchableKey;
      backend?: Backend;
      format?: Format;
      keys?: string[];
    };

    const call: AccessibilityCall = {
      kind: q.marker !== undefined ? "marker" : q.point !== undefined ? "point" : "screen",
      backend: q.backend,
      format: q.format,
      marker: q.marker,
      matchKey: q.matchKey,
      point: q.point,
      keys: q.keys,
    };
    this.calls.push(call);

    if (call.kind === "marker") {
      const hit = (this.options.marker ?? (() => null))(q.marker!, q.matchKey, q.backend);
      if (!hit) throw noElementError(q.marker!);
      // One element under `elements`, never a list (contract check 3).
      return { elements: hit };
    }

    if (call.kind === "point") {
      const hit = (this.options.point ?? (() => null))(q.point!.x, q.point!.y);
      if (!hit) throw wedgeError();
      return hit;
    }

    const screen = this.options.screen ?? (() => screenTree(390, 844));
    return screen(q.backend, call);
  }
}

/** `FakeIdbClient` in the shape `createFakeDeps`'s `client` option wants. */
export function createFakeIdbClient(options: FakeIdbOptions = {}): FakeIdbClient {
  return new FakeIdbClient(options);
}
