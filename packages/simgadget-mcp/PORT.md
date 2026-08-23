# Where this package is, mid-port

The server is a **port onto a finished, validated library**, not something
co-developed with it. `simgadget` passed its own exit gate (SIMGADGET.md step
2) on 2026-08-18; step 3 is landing here, in the order
[SIMGADGET_PLAN_SERVER.md](../../SIMGADGET_PLAN_SERVER.md) sets out, one agent
per group of steps.

The working MCP server is **still `src/index.ts` at the repository root**,
still building, still what `scripts/imsmd.sh` runs. It is the reference to port
from, and it keeps running until step 3.6 deletes it — at which point
`scripts/imsmd.sh`, CI and `.mcp.json` all redirect here in the same commit.

## One deliberate omission, temporary

`private: true` keeps `npm install` and any accidental `npm publish` from doing
something with a half-built package. **Removed at step 7**, when both packages
publish in lockstep.

The second omission is closed. There was **no `bin`** and `build` was a bare
`tsc` while `src/index.ts` did not exist — a `bin` pointing at a missing file
is a broken package the moment anyone links it, and `chmodSync` on one is a
build that fails. Step 3.5 added `"bin": { "simgadget-mcp": "build/index.js" }`
and the chmod together, as the library's own `bin` was held back and then added
together with its entry point.

## The rule this package is built to

`packages/simgadget-mcp` imports `"simgadget"` and **never a deep path** — the
library's `exports` map makes one unresolvable anyway. If a tool cannot be
built from the public API, that is a library API bug, fixed in `simgadget` with
its own unit test, in a commit of its own. Step 3.7 adds a test that checks it.

See SIMGADGET.md ("The MCP on top") for the tool→library call mapping.
