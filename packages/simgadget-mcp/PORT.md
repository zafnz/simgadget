# Nothing here yet — this is where step 3 lands

The server is a **port onto a finished, validated library**, not something
co-developed with it. Until `simgadget` passes its own exit gate (SIMGADGET.md
step 2: `npm test` + typecheck green, and the live e2e suite passing against
the `testapp/` fixture), no code belongs in this directory.

The working MCP server is still `src/index.ts` at the repository root, still
building, still what `scripts/imsmd.sh` runs. It is the reference to port from,
and it keeps running until `tools.ts`, `sessions.ts` and `transport.ts` here
replace it.

`private: true` in package.json is deliberate and temporary: it keeps `npm
install` and any accidental `npm publish` from doing something with an empty
package. Remove it at step 7, when both packages publish in lockstep.

See SIMGADGET.md ("The MCP on top") for the tool→library call mapping, and
SIMGADGET_PLAN.md for where this sits in the order of work.
