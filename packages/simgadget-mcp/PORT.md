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

## Two deliberate omissions, both temporary

`private: true` keeps `npm install` and any accidental `npm publish` from doing
something with a half-built package. **Removed at step 7**, when both packages
publish in lockstep.

There is **no `bin`**, and `build` is a bare `tsc` where the library's also
chmods its entry point. Both wait for `src/index.ts` to exist, at step 3.5: a
`bin` pointing at a file that is not there is a broken package the moment
anyone links it, and `chmodSync` on a missing file is a build that fails.
Step 3.5 adds `"bin": { "simgadget-mcp": "build/index.js" }` and the chmod
together, which is the same reason the library's own `bin` was held back.

## The rule this package is built to

`packages/simgadget-mcp` imports `"simgadget"` and **never a deep path** — the
library's `exports` map makes one unresolvable anyway. If a tool cannot be
built from the public API, that is a library API bug, fixed in `simgadget` with
its own unit test, in a commit of its own. Step 3.7 adds a test that checks it.

See SIMGADGET.md ("The MCP on top") for the tool→library call mapping.
