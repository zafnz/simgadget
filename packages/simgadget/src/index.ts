/**
 * The public surface of `simgadget`, and the only thing a user can resolve:
 * the `exports` map in package.json exposes this module and nothing else, so
 * everything under `ax/`, `idb/` and `internal/` is private in the only way
 * that survives contact with users.
 *
 * Empty until the implementation lands. What arrives here, and in what order,
 * is SIMGADGET_PLAN.md; what it must look like is SIMGADGET.md, which is
 * authoritative for this branch. Signatures in that spec are frozen — a
 * variation needs human signoff, not a judgement call at the keyboard.
 */

export {};
