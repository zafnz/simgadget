/**
 * The exports boundary, checked against the **built** package rather than
 * against `src/`.
 *
 * Everything here is a property of what npm ships: which names a `require`
 * finds, which paths resolve at all, and whether the emitted JavaScript can be
 * loaded by Node. None of that is visible from the source tree — the `exports`
 * map, `rewriteRelativeImportExtensions` and the declaration emit all sit
 * between the two — so this file builds the package first and inspects the
 * output. A test that quietly passed against a stale or missing `build/` would
 * be worse than no test at all, which is why the build is not merely assumed.
 *
 * The `AXElement` assertions at the end are the other half of the boundary: the
 * key set the spec closes, pinned on both sides, since a type cannot be
 * enumerated at runtime and a runtime list cannot be checked by the compiler.
 */

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DESCRIBE_KEYS, canonicalise } from "../src/ax/tree.ts";
// The published type, by the name the published type has.
import type { AXElement } from "../src/index.ts";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(packageRoot, "build");

before(() => {
  // The package's own build script, not a bare `tsc`: the chmod that makes the
  // `bin` executable lives in that script, and what this file inspects should
  // be what `npm publish` would ship. ~1.5s, paid once for the whole file.
  execFileSync("npm", ["run", "build"], { cwd: packageRoot, stdio: "pipe" });
});

/** SIMGADGET.md, "The library API" — the whole of it, and nothing else. */
const PUBLIC_NAMES = [
  "listSimulators",
  "createSimulator",
  "attachSimulator",
  "prefetchCompanion",
  "Simulator",
  "SimGadgetError",
  "UnsupportedArchitectureError",
  "CompanionDownloadError",
  "CompanionStartError",
  "SimulatorNotFoundError",
  "DeviceTypeNotFoundError",
  "SimulatorNotAnsweringError",
  "AccessibilityUnreadableError",
  "ElementNotFoundError",
  "ElementDisabledError",
  "TapObstructedError",
  "ToggleGestureError",
  "UntypeableTextError",
  "TypingBlockedError",
];

/** Every `.js` under `build/`, which is everything Node will ever load. */
function emittedJavaScript(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return emittedJavaScript(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

test("the published package", async (t) => {
  await t.test("exports exactly the spec's surface", () => {
    const published = require("simgadget") as Record<string, unknown>;
    assert.deepEqual(Object.keys(published).sort(), [...PUBLIC_NAMES].sort());
  });

  await t.test("exports no internal by accident", () => {
    const published = require("simgadget") as Record<string, unknown>;
    // Named individually rather than derived, because the point is these
    // particular things: the gRPC client whose reads are `Promise<unknown>`,
    // the process-level companion and recovery registries, the deps seam, and
    // the pure tree logic every element crosses on its way out.
    for (const name of [
      "IdbClient",
      "IdbError",
      "CompanionManager",
      "companions",
      "recoveryRegistry",
      "RecoveryRegistry",
      "realDeps",
      "resolveCompanion",
      "createCompanionResolver",
      "canonicalise",
      "pruneTree",
      "matchInTree",
      "transformPointToPortrait",
      "shouldRecover",
      "readEnv",
    ]) {
      assert.equal(published[name], undefined, `${name} must stay private`);
    }
  });

  await t.test("makes no internal module resolvable, whatever its path", () => {
    // The `exports` map is the only kind of private that survives contact with
    // users: a deep import cannot be written, so it cannot become someone's
    // dependency and cannot be broken by moving a file.
    for (const deep of [
      "simgadget/build/idb/client.js",
      "simgadget/build/idb/companionManager.js",
      "simgadget/build/internal/deps.js",
      "simgadget/build/ax/tree.js",
      "simgadget/build/index.js",
      "simgadget/package.json",
    ]) {
      assert.throws(
        () => require.resolve(deep),
        (error: NodeJS.ErrnoException) =>
          error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
        `${deep} must not resolve`
      );
    }

    // ...while the package root does, and is the built entry.
    assert.equal(require.resolve("simgadget"), path.join(buildDir, "index.js"));
  });

  await t.test("ships an executable bin", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")
    ) as { bin: Record<string, string> };
    const cli = path.join(packageRoot, manifest.bin.simgadget);

    // An unexecutable `bin` installs as a symlink nobody can run, and npm says
    // nothing about it.
    assert.ok(fs.statSync(cli).mode & 0o111, `${cli} is not executable`);
    assert.match(fs.readFileSync(cli, "utf-8"), /^#!\/usr\/bin\/env node/);
  });

  await t.test("emits no import of a .ts path", () => {
    // `rewriteRelativeImportExtensions` turns `./ax/tree.ts` into
    // `./ax/tree.js` in the JavaScript, and a `.ts` specifier surviving into
    // the emitted code is a module Node cannot load -- a runtime break that no
    // typecheck sees. (A `.ts` specifier in a `.d.ts` is expected and correct:
    // TypeScript maps `./x.ts` to `./x.d.ts` for consumers.)
    const offenders = emittedJavaScript(buildDir).flatMap((file) => {
      const matches = fs
        .readFileSync(file, "utf-8")
        .match(/["'](\.\.?\/[^"']*\.ts)["']/g);
      return matches ? [`${path.relative(packageRoot, file)}: ${matches.join(", ")}`] : [];
    });
    assert.deepEqual(offenders, []);
  });
});

// ---- the closed AXElement --------------------------------------------------

/** SIMGADGET.md, "Shared types": these seven keys, and no index signature. */
const PUBLIC_ELEMENT_KEYS = [
  "AXLabel",
  "AXValue",
  "AXUniqueId",
  "type",
  "enabled",
  "frame",
  "children",
] as const;

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// Checked by `npm run typecheck` (tsconfig.test.json covers `test/`), and the
// reason the closed type is enforced rather than merely intended: an index
// signature would widen `keyof` to `string | number` and fail here, and so
// would a key added to the type without being added to the list above.
type _keys = Expect<Equal<keyof AXElement, (typeof PUBLIC_ELEMENT_KEYS)[number]>>;
// The internal type's label is `string | null`; the published one's is not,
// because `canonicalise` drops the nulls rather than passing them on.
type _label = Expect<Equal<AXElement["AXLabel"], string | undefined>>;
type _value = Expect<Equal<AXElement["AXValue"], string | number | undefined>>;
type _children = Expect<Equal<AXElement["children"], AXElement[] | undefined>>;

test("the public AXElement's key set", async (t) => {
  await t.test("is the keys asked for, plus the children pruning adds", () => {
    // The runtime half of the type assertions above: `DESCRIBE_KEYS` is what a
    // read asks the companion for and what `canonicalise` copies, so the two
    // lists drifting apart is how a key would quietly leave the type or arrive
    // in it without anyone deciding to publish it.
    assert.deepEqual(
      [...DESCRIBE_KEYS, "children"].sort(),
      [...PUBLIC_ELEMENT_KEYS].sort()
    );
  });

  await t.test("is all a canonicalised element ever carries", () => {
    const canonical = canonicalise({
      AXLabel: "Continue",
      frame: { x: 1, y: 2, width: 3, height: 4 },
      AXValue: "1",
      AXUniqueId: "continue-button",
      type: "Button",
      enabled: true,
      // Everything a companion sends that the type does not promise: the
      // backends disagree about these, and an open type would publish that
      // disagreement.
      role: "AXButton",
      traits: ["button"],
      pid: 4242,
      AXFrame: "{{1, 2}, {3, 4}}",
      children: [{ AXLabel: "Label" }],
    });

    assert.deepEqual(
      Object.keys(canonical).sort(),
      ["AXLabel", "AXUniqueId", "AXValue", "enabled", "frame", "type"]
    );
  });
});
