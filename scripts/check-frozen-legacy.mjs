#!/usr/bin/env node
/**
 * Guards the repo-root `src/ax/` and `src/idb/` against being edited by
 * mistake while `packages/simgadget/src/` carries copies of the same files.
 *
 * The scaffold took `ax/` and `idb/` into the new package as copies, not
 * moves, so that the old MCP server at the repo-root `src/index.ts` keeps
 * building and `scripts/imsmd.sh` keeps running it throughout the migration
 * (SIMGADGET_PLAN.md, "Deviations from the spec's layout", item 3). That
 * leaves two copies of the same logic on disk for the length of the phase,
 * and the failure mode is an agent fixing a bug in the copy it happens to
 * have open — the repo-root original — and never noticing the fix did not
 * reach `packages/simgadget`, because both copies compile and both look
 * plausible. This script makes that silent loss into a red test instead: it
 * hashes every frozen file and fails loudly the moment one changes.
 *
 * THE FIX IS NEVER TO REGENERATE THE MANIFEST. If this goes red, the edit
 * belongs in `packages/simgadget/src/`, not here — move it there, restore
 * this file with `git checkout -- <path>`, and re-run. The one legitimate
 * use of `--update` is step 3 of SIMGADGET.md, when the repo-root copies are
 * deleted for good — at which point this script and its manifest are deleted
 * too, not kept in sync.
 *
 * Usage:
 *   node scripts/check-frozen-legacy.mjs            # verify (wired into `npm test`)
 *   node scripts/check-frozen-legacy.mjs --update    # regenerate the manifest
 */
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(REPO, "scripts", "frozen-legacy.sha256");

const FROZEN_GLOBS = [
  { dir: "src/ax", recursive: false },
  { dir: "src/idb", recursive: true },
];

/** Every `.ts` file under one of the frozen roots, as repo-relative POSIX paths. */
function listFrozenFiles() {
  const files = [];
  for (const { dir, recursive } of FROZEN_GLOBS) {
    const abs = path.join(REPO, dir);
    walk(abs, recursive, files);
  }
  return files.sort();
}

function walk(dir, recursive, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // Absent entirely is reported by the manifest diff, not here.
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) walk(abs, recursive, out);
      continue;
    }
    if (entry.name.endsWith(".ts")) {
      out.push(path.relative(REPO, abs).split(path.sep).join("/"));
    }
  }
}

function sha256(absPath) {
  return createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
}

function currentManifest() {
  const map = new Map();
  for (const rel of listFrozenFiles()) {
    map.set(rel, sha256(path.join(REPO, rel)));
  }
  return map;
}

function formatManifest(map) {
  return (
    [...map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([rel, hash]) => `${hash}  ${rel}`)
      .join("\n") + "\n"
  );
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return new Map();
  const map = new Map();
  const text = fs.readFileSync(MANIFEST_PATH, "utf-8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (!match) continue;
    const [, hash, rel] = match;
    map.set(rel, hash);
  }
  return map;
}

const update = process.argv.includes("--update");
const current = currentManifest();

if (update) {
  fs.writeFileSync(MANIFEST_PATH, formatManifest(current));
  console.log(
    `Wrote ${MANIFEST_PATH.replace(REPO + path.sep, "")} from the current contents of ` +
      `${FROZEN_GLOBS.map((g) => g.dir).join(" and ")} (${current.size} files).\n\n` +
      `Only legitimate when the repo-root copies are being retired for good ` +
      `(SIMGADGET.md step 3) — never to make this check pass again after an edit.`
  );
  process.exit(0);
}

const recorded = readManifest();

let failures = 0;
const record = (pass, name, detail) => {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`        ${detail}`);
};

if (recorded.size === 0) {
  console.error(
    `No manifest at scripts/frozen-legacy.sha256 (or it is empty). Generate it ` +
      `once with:\n\n  node scripts/check-frozen-legacy.mjs --update\n`
  );
  process.exit(2);
}

const changed = [];
const added = [];
const missing = [];

for (const [rel, hash] of current) {
  if (!recorded.has(rel)) {
    added.push(rel);
  } else if (recorded.get(rel) !== hash) {
    changed.push(rel);
  }
}
for (const rel of recorded.keys()) {
  if (!current.has(rel)) missing.push(rel);
}

record(
  changed.length === 0,
  "no frozen file's contents changed",
  changed.length ? changed.sort().join("\n        ") : undefined
);
record(
  added.length === 0,
  "no new file appeared under a frozen directory",
  added.length ? added.sort().join("\n        ") : undefined
);
record(
  missing.length === 0,
  "no frozen file went missing",
  missing.length ? missing.sort().join("\n        ") : undefined
);

if (failures) {
  console.log(
    `\n${changed.length + added.length + missing.length} file(s) under src/ax/ or src/idb/ ` +
      `no longer match scripts/frozen-legacy.sha256.\n\n` +
      `These are the frozen originals — packages/simgadget/src/ carries the copies ` +
      `that are meant to change during this migration. THE FIX IS TO MOVE THE EDIT ` +
      `INTO packages/simgadget/src/, never to run --update here. If the edit above ` +
      `was a mistake, restore the original with:\n\n` +
      `  git checkout -- <path>\n\n` +
      `--update is only legitimate once these files are deleted for good ` +
      `(SIMGADGET.md step 3), at which point this script and its manifest are ` +
      `deleted too, not resynced.`
  );
} else {
  console.log(`\nAll ${current.size} frozen file(s) match the manifest.`);
}

process.exit(failures ? 1 : 0);
