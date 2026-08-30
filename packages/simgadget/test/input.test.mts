/**
 * The typing gate: the cheap question asked before every `typeText`, deciding
 * whether the expensive one is worth asking at all.
 *
 * Pure, so the trait names — which are somebody else's and undocumented — are
 * pinned here in milliseconds rather than by booting a simulator. What the real
 * companion publishes for a focused secure field is checked by the
 * `--password-sheet` mode of `scripts/check-companion-contract.mjs`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { editingSecureField, TYPING_GATE_KEYS } from "../src/ax/input.ts";
import type { RawAXElement } from "../src/ax/tree.ts";

/** An element carrying `traits`, which no public read returns. */
const withTraits = (traits: string[], rest: Partial<RawAXElement> = {}): RawAXElement =>
  ({ type: "TextField", traits, ...rest }) as RawAXElement;

/**
 * The traits the pinned companion reports for the fixture's fields, measured
 * 2026-08-30. The plain field differs from the secure one by exactly one entry,
 * which is the distinction the gate rests on.
 */
const PLAIN_FOCUSED = ["TextEntry", "TextOperationsAvailable", "Scrollable", "IsEditing"];
const SECURE_FOCUSED = [
  "SecureTextField",
  "Scrollable",
  "TextOperationsAvailable",
  "IsEditing",
  "TextEntry",
];
const SECURE_UNFOCUSED = ["SecureTextField", "TextOperationsAvailable", "TextEntry", "Scrollable"];

test("editingSecureField", async (t) => {
  await t.test("is true for a focused secure field", () => {
    assert.equal(editingSecureField([withTraits(SECURE_FOCUSED)]), true);
  });

  await t.test("is false for a secure field nobody is typing into", () => {
    // Both traits must be present on the *same* element. A password field
    // sitting on screen unfocused is the common case on any login form, and
    // paying the sheet check for it would defeat the gate.
    assert.equal(editingSecureField([withTraits(SECURE_UNFOCUSED)]), false);
  });

  await t.test("is false for a focused plain field", () => {
    assert.equal(editingSecureField([withTraits(PLAIN_FOCUSED)]), false);
  });

  await t.test("does not combine traits across two elements", () => {
    // A secure field over here and an edited field over there is not an edited
    // secure field. Written because the obvious flat-scan implementation —
    // "some element has IsEditing, some element has SecureTextField" — passes
    // every other test in this file.
    assert.equal(
      editingSecureField([withTraits(SECURE_UNFOCUSED), withTraits(PLAIN_FOCUSED)]),
      false
    );
  });

  await t.test("finds one nested at depth", () => {
    // A field inside a real app sits many levels down.
    const tree = [
      {
        type: "Application",
        children: [
          { type: "Other", children: [withTraits(PLAIN_FOCUSED)] },
          { type: "Other", children: [{ type: "Other", children: [withTraits(SECURE_FOCUSED)] }] },
        ],
      },
    ] as RawAXElement[];
    assert.equal(editingSecureField(tree), true);
  });

  await t.test("tolerates elements with no traits at all", () => {
    // `traits` is outside DESCRIBE_KEYS, so most elements in most trees the
    // library reads do not carry it. A missing key is not a match and not a
    // crash.
    const tree = [
      { type: "Application", children: [{ type: "Button" }, { traits: "not-an-array" }] },
    ] as unknown as RawAXElement[];
    assert.equal(editingSecureField(tree), false);
  });

  await t.test("is false for an empty read", () => {
    assert.equal(editingSecureField([]), false);
  });

  await t.test("asks for traits, and for little else", () => {
    // The gate is only worth having while it is cheap, and the key set is what
    // makes it cheap.
    assert.ok(TYPING_GATE_KEYS.includes("traits"));
    assert.ok(TYPING_GATE_KEYS.length <= 3, `${TYPING_GATE_KEYS.length} keys is not a cheap read`);
  });
});
