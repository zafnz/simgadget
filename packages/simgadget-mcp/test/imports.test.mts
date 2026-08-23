/**
 * The rule the whole split rests on: **this package imports `"simgadget"` and
 * never a deep path.**
 *
 * It is one line in SIMGADGET.md and it is load-bearing in both directions. A
 * deep import — `simgadget/build/lifecycle.js`, say — reaches past the public
 * API into a module the library is free to rename in a patch release, and it
 * turns "the library is finished, the server is a renderer" into a shape where
 * the server quietly owns half the library's internals. The `exports` map
 * makes such a path unresolvable *today*, which is a real guard but a fragile
 * one: it is one `"./*"` entry away from stopping, and nothing would announce
 * that.
 *
 * So the check is cheap and it is here rather than in a grep somebody remembers
 * to run. It also refuses to pass vacuously: a `src/` that stopped importing
 * the library at all would satisfy every assertion below by saying nothing, so
 * the last test insists the import exists.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every `.ts` file under `src/`, relative to it. */
function sources(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .sort();
}

/**
 * Every module specifier a file names, however it names one.
 *
 * Four forms, because one of them missed is a hole rather than a gap: `from
 * "x"` (covers `import`, `import type` and `export … from`), a bare side-effect
 * `import "x"`, `require("x")`, and dynamic `import("x")`.
 */
function specifiersIn(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

const FILES = sources().map((file) => ({
  file,
  specifiers: specifiersIn(readFileSync(path.join(SRC, file), "utf8")),
}));

test("the import boundary", async (t) => {
  await t.test("there is source to check", () => {
    // Guards against a rename or a moved directory turning this whole file
    // into a no-op that passes.
    assert.ok(FILES.length >= 5, `expected several source files, found ${FILES.length}`);
  });

  await t.test("every reference to the library is the bare package name", () => {
    for (const { file, specifiers } of FILES) {
      for (const specifier of specifiers) {
        if (!specifier.startsWith("simgadget")) continue;
        assert.equal(
          specifier,
          "simgadget",
          `${file} imports "${specifier}"; the library is only ever imported as "simgadget"`
        );
      }
    }
  });

  await t.test("nothing reaches into the library's build or source tree", () => {
    // The spellings a relative path would take if `packages/simgadget` were
    // reached around the package boundary rather than through it.
    for (const { file, specifiers } of FILES) {
      for (const specifier of specifiers) {
        assert.ok(
          !specifier.includes("packages/simgadget"),
          `${file} imports "${specifier}", which reaches into the library by path`
        );
        assert.ok(
          !/(^|\/)\.\.\/\.\.\//.test(specifier),
          `${file} imports "${specifier}", which climbs out of this package`
        );
      }
    }
  });

  await t.test("the library is actually imported, so this is not vacuous", () => {
    const importers = FILES.filter(({ specifiers }) => specifiers.includes("simgadget"));
    assert.ok(
      importers.length > 0,
      "no file in src/ imports \"simgadget\" — the checks above would pass on an empty rule"
    );
  });
});
