/**
 * The rules `tap()` decides by, as pure functions.
 *
 * Every one of them exists because a tap once did the wrong thing and reported
 * success — a control that ignored the touch because it was disabled, a toggle
 * whose centre is not its control, a press so short UIKit missed it. Those are
 * exactly the faults a type checker cannot see and a simulator boot is
 * expensive to see, so they live here where a test costs microseconds and the
 * evidence for each constant can sit next to it.
 *
 * `simulator.ts` keeps the wiring: which companion call each verdict turns
 * into, what it reads back, and which typed error it throws. Nothing here
 * touches a companion, a clock or a filesystem.
 */

import { isToggle, normaliseForMatch, type AXElement } from "./tree.ts";

/**
 * The shortest press that actually actuates a control.
 *
 * A tap with no hold is a touch-down and a touch-up in the same instant, and
 * UIKit does not reliably see one. Measured against the Sound switch in
 * Settings > General > Keyboard, tapping the control itself:
 *
 *   | companion         | instant | 0.1s hold |
 *   |-------------------|---------|-----------|
 *   | pinned da0f89a    |    5/12 |     12/12 |
 *   | brew 1.1.8 (2022) |    1/10 |     10/10 |
 *
 * So this is not a regression in some version — an instantaneous touch has
 * always been worth about a coin flip, and every tap this codebase sent was one
 * unless the caller thought to ask for a duration. It is the likeliest
 * explanation for taps that "sometimes don't take".
 */
export const MIN_TAP_HOLD_SECONDS = 0.1;

/**
 * The press duration a tap is actually delivered with.
 *
 * A floor rather than a default, because a caller passing a shorter press is
 * asking for the unreliable behaviour by accident: the distinction that matters
 * to them is tap versus long-press, and 0.1s is well under UIKit's 0.5s
 * long-press threshold, so nothing that was a tap becomes one.
 *
 * A duration that is not a finite number is treated as none at all rather than
 * propagated: `NaN` survives `Math.max` and would reach the companion as a
 * hold of nothing, which is the very failure the floor exists to prevent.
 */
export function holdSeconds(requested?: number): number {
  const asked = typeof requested === "number" && Number.isFinite(requested) ? requested : 0;
  return Math.max(asked, MIN_TAP_HOLD_SECONDS);
}

/**
 * What a tap aimed by name should do with the element it resolved — or which
 * error code says why it should not.
 *
 * `"touch"` and `"activation"` are the two verbs; the other two are
 * `ErrorCode`s, returned rather than thrown so this stays a pure decision and
 * `simulator.ts` remains the only place that knows how to build an error's
 * payload.
 */
export type TapVerb =
  | "touch"
  | "activation"
  | "element-disabled"
  | "toggle-needs-plain-tap";

/** The subset of `TapOptions` the decision reads. */
export interface TapGesture {
  durationSeconds?: number;
  count?: number;
}

/**
 * The whole disabled/toggle/gesture decision, in the order `tap()` makes it.
 *
 *  1. **Disabled first, because it is free and it forecloses a whole category
 *     of confusion**: a disabled control receives the touch and ignores it, so
 *     "the tap did nothing" looks identical to a mis-aimed tap.
 *  2. **A plain tap on a toggle is an activation, not a touch.** A toggle's
 *     frame is routinely not its actuating region: a Settings row fuses label
 *     and control into one element spanning the row, so its centre is the gap
 *     between them, and even a bare `UISwitch` inherits whatever width its
 *     layout gives it — in this project's own fixture, 282 points of frame
 *     around 63 points of control at the leading edge. Measured 0/6 and 0/8,
 *     with and without a hold, on the pinned companion and the 2022 one alike.
 *     It has never worked, so the element is activated the way VoiceOver
 *     activates it instead.
 *  3. **A hold or a multi-tap on a toggle is refused**, because those can only
 *     be a real touch and a real touch at a toggle's centre lands nowhere. Not
 *     delivering a gesture that cannot work beats delivering it and reporting
 *     success — which is what was measured happening, silently, before this
 *     check existed.
 *
 * A `durationSeconds` of any value at all, including one below the floor, makes
 * it a hold: the caller asking for a duration is what distinguishes them, not
 * the number they chose.
 */
export function decideTapVerb(element: AXElement, gesture: TapGesture = {}): TapVerb {
  if (element.enabled === false) return "element-disabled";
  if (!isToggle(element)) return "touch";
  const plain = gesture.durationSeconds === undefined && (gesture.count ?? 1) === 1;
  return plain ? "activation" : "toggle-needs-plain-tap";
}

/**
 * Whether the point that was aimed at actually reached the element aimed for.
 *
 * `null` — an empty point — counts as not reaching it, and is the commoner
 * case: an element scrolled past the bottom of the screen has a perfectly
 * correct frame whose centre belongs to nothing at all.
 *
 * **Both the touch and the activation are gated on this, and the activation is
 * the one that was missing.** The touch path has hit-tested since #64a. The
 * activation path did not, on the stated grounds that `AXPress` does not
 * hit-test and so reaches controls a finger cannot — and that premise turned
 * out to be false. Measured on this project's fixture with a switch under the
 * toolbar: the activation reported that it had operated the switch, the switch
 * did not change, and the toolbar's *button* fired instead (#105). What a
 * covered activation actually does is operate whatever is on top, so the
 * capability the exception was protecting does not exist.
 *
 * ## Why this is not `sameElement`
 *
 * It was, and the fixture caught it inside an hour. `sameElement` accepts frame
 * containment **in both directions**, which is right for asking "are these two
 * reads the same control" and wrong for asking "did the point reach it": a
 * toolbar button 139pt wide encloses a 63pt switch sitting under it, so the
 * covering control compared equal to the control it was covering and the gate
 * let the activation through. Measured on the fixture's `CoveredSwitch`
 * (`{x:40 y:808 w:63 h:28}`) under `ToolbarButton` (`{x:6.7 y:803 w:139
 * h:38}`) — enclosed on all four sides.
 *
 * So containment counts in one direction only. The point reached the target if
 * what is there is:
 *
 *  - **the same control**, by unique id or by label — the two elements come
 *    from different reads (a lookup by label, a hit-test by point), so identity
 *    is not available and these are what carry across; or
 *  - **inside the target** — the `StaticText` inside a button is what a point
 *    read returns for the button, and refusing that would refuse every labelled
 *    button on screen.
 *
 * What is deliberately *not* accepted is the reverse: something that merely
 * encloses the target. A container the target sits inside is not the target,
 * and neither is a toolbar drawn over it — in both cases the touch lands on the
 * bigger thing, which is the whole failure this gate exists to prevent.
 */
export function hitTestReaches(target: AXElement, atPoint: AXElement | null): boolean {
  if (atPoint === null) return false;

  const targetId = target.AXUniqueId;
  const pointId = atPoint.AXUniqueId;
  if (typeof targetId === "string" && targetId && targetId === pointId) return true;

  const targetLabel =
    typeof target.AXLabel === "string" ? normaliseForMatch(target.AXLabel) : "";
  const pointLabel =
    typeof atPoint.AXLabel === "string" ? normaliseForMatch(atPoint.AXLabel) : "";
  if (targetLabel && targetLabel === pointLabel) return true;

  const outer = target.frame;
  const inner = atPoint.frame;
  if (!outer || !inner) return false;
  // One pixel of slack on each edge: both frames are thirds-of-a-point values
  // rounded differently by two different reads.
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1
  );
}

/**
 * A toggle's `AXValue` in the words a person uses for it.
 *
 * **Presentation only, and deliberately not on the result.** `TapResult` carries
 * the raw `before`/`after` the companion reported, because that is the datum and
 * a host renders it (design rule 1); this is the rendering the hosts in this
 * repository want, kept here so the one non-obvious part — that iOS reports a
 * switch's state as the *string* `"1"`, not the number, and that anything else
 * is passed through rather than guessed at — has a test rather than being
 * rewritten from memory in each of them.
 */
export function toggleState(value: unknown): string {
  if (value === "1" || value === 1) return "on";
  if (value === "0" || value === 0) return "off";
  return `${value}`;
}
