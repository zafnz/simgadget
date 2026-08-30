/**
 * The typing decisions: whether a keystroke is about to go somewhere that will
 * not receive it, and how cheaply that can be established.
 *
 * Pure and dependency-free, like the rest of `ax/`. The reads live in
 * `simulator.ts`; only the decisions are here, because these are the rules that
 * are wrong in a way a type checker cannot see and checking one against a
 * device costs a simulator boot.
 */

import type { RawAXElement } from "./tree.ts";

/**
 * The keys the cheap gate asks for.
 *
 * Deliberately not `DESCRIBE_KEYS`: the gate needs `traits`, which no public
 * read returns, and needs nothing else except an identifier to name what it
 * found. Measured against the pinned companion on iOS 26, 2026-08-30, the
 * difference is worth asking for — the fixture's main screen answers this set
 * in ~88ms and 4.4KB, where the full set is several times that.
 */
export const TYPING_GATE_KEYS = ["AXUniqueId", "traits"];

/**
 * iOS's trait for a field that masks what is typed into it — a
 * `secureTextEntry` `UITextField`.
 */
const SECURE_FIELD_TRAIT = "SecureTextField";

/**
 * iOS's trait for the field that currently has the keyboard. This is the only
 * focus indicator the companion publishes: there is no `AXFocused` key, and a
 * marker query cannot ask for "the focused one", so a whole-screen read and
 * this trait is the whole mechanism.
 */
const EDITING_TRAIT = "IsEditing";

function traitsOf(element: RawAXElement): string[] {
  const traits = (element as { traits?: unknown }).traits;
  return Array.isArray(traits) ? traits.filter((t): t is string => typeof t === "string") : [];
}

/**
 * Whether a masked field currently has the keyboard.
 *
 * This is the gate in front of the strong-password sheet check, and it exists
 * for one reason: the sheet is drawn by another process and only AXBridge can
 * see it, at ~300ms a read, where this answers from the default backend in
 * ~22–88ms. Typing into a password field is rare and typing into every other
 * kind of field is not, so the expensive question is worth asking only once
 * this one says yes.
 *
 * It is deliberately *not* a reason to refuse on its own. A plain
 * `secureTextEntry` field — the fixture's `PasswordField` — types perfectly
 * well; it is only the sheet iOS raises over a `newPassword` field that
 * swallows keystrokes. Refusing here would refuse the working case too.
 */
export function editingSecureField(roots: RawAXElement[]): boolean {
  const stack = [...roots];
  while (stack.length > 0) {
    const element = stack.pop();
    if (!element || typeof element !== "object") continue;
    const traits = traitsOf(element);
    if (traits.includes(EDITING_TRAIT) && traits.includes(SECURE_FIELD_TRAIT)) return true;
    for (const child of element.children ?? []) stack.push(child as RawAXElement);
  }
  return false;
}
