# Contributing to SimGadget

**Important Note**:
This is a fork of the original [joshuayoes/ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp) MCP. The changes this fork makes are fundamentally different to Joshua's intent, so I chose to fork as Open Source ecology intended. If you wish to contribute to this project that is wonderful, but I highly encourage you to see if your contributions can also benefit the original project too. 

## Project Philosophy

This project is **intentionally simple** and follows these core principles:

### One rule decides where code goes

This repository is two packages — `packages/simgadget`, the library, and
`packages/simgadget-mcp`, the MCP server built on it — and the rule that keeps
them apart is short:

> **State keyed by udid belongs to the library. State keyed by session id
> belongs to the server.**

A simulator's companion connection, its orientation, its recovery bookkeeping
are facts about a *device*: library. Session ids, the `owned` flag,
delete-on-exit, tool filtering, transports are facts about *a server*.

Two things follow from it, and both matter before you open a file:

- **The server imports `"simgadget"` and never a deep path.** The library's
  `exports` map makes a deep path unresolvable, and a test asserts the import
  stays shallow. If a tool cannot be built from the public API, that is a
  library API bug to fix in `simgadget` — say so rather than reaching around it.
- **The 17 tool registrations stay together in `tools.ts`.** They are
  repetitive and read better side by side. That half of the old single-file
  rule survives; the rest of it is gone, and [CLAUDE.md](CLAUDE.md#architecture)
  has the current layout.

### Simplicity First

- **Minimal dependencies**: We keep dependencies minimal to ensure fast installs and small footprint on user machines. The library's runtime dependencies are gRPC and protobuf, and nothing else — that is why the MCP SDK and Zod live in a separate package rather than in front of every library user
- **Standard tooling**: We use `npm` (universally available) and `tsc` (simple, already available) for building

### Real Use Cases Only

- New tools should be driven by **real use cases**, not hypothetical situations
- We are **not trying to include every possible tool** - additional tools can pollute context windows and confuse AI agents
- The original use case: Give AI editors the ability to interact with iOS simulators like a user, similar to [playwright-mcp](https://github.com/microsoft/playwright-mcp) for browsers
- This enables autonomous agent loops where AI can validate its own work in the iOS simulator

### Every action answers with what happened

No success strings. A call that acted says what it did and what it read back;
a call that failed throws a typed error with a `code` and a payload, and
nothing anywhere regexes a message. "Absent" is an answer, not an error —
`findByLabel` and `describePoint` return `null` for a clean miss.

This is not style. Silent success is the bug class this codebase has spent the
most simulator boots on: a tap delivered to a control that was covered,
disabled, or scrolled out of view looks exactly like a tap that worked.

### The regression rule

**A newly discovered bug requires three things:**

1. the fix,
2. a step added or adjusted in [TESTING_TOOLS.md](docs/testing/TESTING_TOOLS.md) that would
   have caught it against the `testapp/` fixture,
3. a unit test that catches it in milliseconds.

A unit test is only possible when the broken rule is pure logic. When it is
not, that is the signal to extract the decision into a pure function first —
which is exactly how `packages/simgadget/src/ax/recovery.ts` came to exist.
Every rule in `ax/` traces back to a bug that cost simulator boots to find.

### Architectural Stability

If you want to make significant changes to this fork then I'd suggest talking to the author first, however you could equally just fork your own too ;).

## Prerequisites

Before contributing, ensure you have:

- **macOS on Apple Silicon** (iOS simulators only work on macOS, and the companion build output is arm64 only)
- **Node.js** installed
- **Xcode** and iOS simulators installed
- An **MCP client** (like Cursor) for testing

You do not install `idb_companion` — the library resolves it itself (env var, then a local build of the vendored submodule, then a pinned download), and the server gets it through the library. No Python `fb-idb` and no `brew install idb-companion`; this talks to the companion directly over gRPC. See [How `idb_companion` is obtained](README.md#how-idb_companion-is-obtained) for the full precedence order, and [Building the companion](#building-the-companion) below if you want the developer path.

For additional context and references, see [CONTEXT.md](CONTEXT.md) which contains helpful links for MCP development, iOS simulator commands, and security considerations.

## Development Setup

1. **Fork and clone the repository**

   idb is vendored as a git submodule at `vendor/idb`, pinned to a specific
   sha, so clone recursively:

   ```bash
   git clone --recurse-submodules https://github.com/your-username/simgadget.git
   cd simgadget
   ```

   If you already cloned without it, run `git submodule update --init`.

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Build the project** — a workspace root, so both packages at once

   ```bash
   npm run build
   ```

   Use the root script rather than `npm run build --workspaces`: npm does not
   order workspace lifecycle scripts by dependency, and `simgadget-mcp`'s `tsc`
   needs the library's declarations to already exist. The root's `build` is
   where that order is written down.

4. **Test during development**

   ```bash
   # Watch mode for development, one package at a time
   npm run watch --workspace=simgadget-mcp

   # Test with MCP inspector
   npm run dev
   ```

## The vendored idb submodule

`vendor/idb` is [facebook/idb](https://github.com/facebook/idb) pinned to a
specific sha. It is the source of two things: the `idb_companion` binary the
library talks to, and the generated gRPC client and keymap under
`packages/simgadget/src/idb/`.

### Bumping to a newer idb

```bash
cd vendor/idb && git fetch && git checkout <sha> && cd ../..
npm run gen                       # regenerate the client and keymap
git commit -am "build: bump idb to <sha>"
git push
```

Pushing a moved submodule pointer is what triggers the companion build in CI.
It builds, smoke tests the artifact, publishes a release and produces a new
`companion.lock.json` — commit that lock file to point the server at the new
companion.

The build only runs when the idb pin or `.xcode-version` actually changes.
Ordinary pushes, and merges that carry an unchanged submodule pointer, skip it:
a macOS runner costs 10x minutes and a rebuild of the same commit produces a
byte-identical artifact. Use the workflow's **force** input to build anyway.

Check `vendor/idb/REPL/IDB/IDBAPI.swiftinterface` after a bump — its
`swift-compiler-version` line is upstream's own toolchain stamp, and
`.xcode-version` must agree with it. CI asserts this, because a mismatch does
not produce a compiler error, it produces a crash with no diagnostic at all.

### Building the companion

You do not need to build anything to run the server — it will download the
companion pinned in `companion.lock.json`. Build locally when you are working on
companion behaviour itself, or bumping the submodule. A build at
`vendor/idb/Build/Distribution/idb_companion` is picked up automatically, ahead
of the download.

**Xcode 26.6 exactly** is required, pinned in `.xcode-version`. Plus:

```bash
brew install xcodegen protobuf swift-protobuf
```

Then:

```bash
cd vendor/idb && ./build.sh build
```

It takes 20–30 minutes and produces `vendor/idb/Build/Distribution/`. The output
is **arm64 only**.

The version pin is not decoration: a mismatched Swift toolchain does not give
you a build error, it crashes the compiler with a bare stack dump and no message
about what is wrong. If that happens, check your Xcode version first.

### Regenerating the client (`npm run gen`)

```bash
npm run gen
```

This regenerates the gRPC client and the keymap from the submodule
(`gen:proto` + `gen:keymap`). The output is checked in, so only maintainers
bumping the submodule sha need to run it. Never hand-edit the generated files.

## Dependency Management & Upgrades

We align our dependencies with those used by `@modelcontextprotocol/sdk`, which reduces version conflicts with MCP clients.

### Current Dependency Strategy

- **`@modelcontextprotocol/sdk`**: pinned exactly (currently `1.18.2`) —
  the tool surface is diffed against a captured baseline, and an SDK that
  changes how a Zod schema becomes JSON Schema turns that test red
- **`zod`**: match the version used by `@modelcontextprotocol/sdk`
- **`typescript`**: match the version used by `@modelcontextprotocol/sdk`
- **`@types/node`**: match the version used by `@modelcontextprotocol/sdk`

Where we currently sit, checked 2026-08-24:

| dep | ours | the SDK's |
|---|---|---|
| `zod` | `^3.23.8` | `^3.25 \|\| ^4.0` |
| `typescript` | `^5.5.4` | `^5.5.4` |
| `@types/node` | `^22.0.2` | `^22.12.0` |

The two mismatched ranges resolve to versions inside the SDK's, so nothing is
broken today; they are drift rather than a fault, and the table exists so the
next person checking does not have to re-derive it.

### Checking for Updates

Before upgrading dependencies, check what versions the MCP SDK uses:

```bash
# Check MCP SDK dependencies
npm info @modelcontextprotocol/sdk dependencies

# Check MCP SDK dev dependencies
npm info @modelcontextprotocol/sdk devDependencies

# Compare with current project dependencies
npm ls --depth=0
```

### Upgrading Dependencies

1. **Check MCP SDK versions first**:

   ```bash
   npm info @modelcontextprotocol/sdk dependencies devDependencies
   ```

2. **Update package.json to match**:

   - Update `zod` to match MCP SDK version
   - Update `typescript` to match MCP SDK version
   - Update `@types/node` to match MCP SDK version
   - Keep `@modelcontextprotocol/sdk` at latest stable

3. **Install and test**:

   ```bash
   npm install
   npm run build
   npm run dev  # Test with MCP inspector
   ```

4. **Verify compatibility**:
   - Test all existing functionality
   - Run through [TESTING_TOOLS.md](docs/testing/TESTING_TOOLS.md), and [TESTING_SERVER.md](docs/testing/TESTING_SERVER.md) if transports or sessions are affected
   - Ensure no new TypeScript errors (`npm run typecheck`)

### Why This Matters

- **Compatibility**: the tools keep working with MCP clients
- **Stability**: Reduces version conflicts and unexpected behavior
- **Consistency**: Maintains a predictable development environment
- **Future-proofing**: Easier to adopt new MCP SDK features and fixes

### When to Deviate

Only deviate from MCP SDK dependency versions when:

- A security vulnerability requires a newer version
- A critical bug fix is only available in a newer version
- The MCP SDK explicitly supports newer versions

In such cases, document the deviation and reasoning in the pull request.

## Making Changes

### Code Style

- Follow the existing TypeScript patterns in the codebase
- **Comments explain why, never what.** Nearly every constant here is what it is because a simulator boot was spent finding out the obvious value is wrong; the comment is the evidence
- In the server, error text comes from `render.ts` — `toError()`, `handleToolError()` and `errorWithTroubleshooting()` — and never from a tool body. It is the only pure part of the server, which is what makes it the only part that can be tested exhaustively
- In the library, pure logic that can be unit tested belongs in `packages/simgadget/src/ax/`, which must stay free of dependencies on simulators, companions, the filesystem — and on each other
- Library error messages never name an MCP tool, a GitHub issue URL, or any remedy that assumes a particular host. Hosts render their own guidance from `code` plus payload

### Adding New Tools

Before adding a new tool, ask yourself:

1. **Is this driven by a real use case?** Provide specific examples of when this tool would be needed
2. **Can existing tools solve this problem?** Check if current functionality can address the need
3. **Will this add significant value without cluttering the context?** Consider the trade-off between utility and complexity

If adding a new tool:

1. Follow the existing pattern with `isToolFiltered()` check
2. Use proper Zod schemas for input validation
3. Include comprehensive error handling with troubleshooting links
4. Use the `--` separator when passing user input to commands (security best practice)
5. Add the tool to the README.md and AGENT_INSTRUCTIONS.md documentation, and a step to [TESTING_TOOLS.md](docs/testing/TESTING_TOOLS.md)
6. A tool's description and `SERVER_INSTRUCTIONS` are pinned by
   `packages/simgadget-mcp/test/fixtures/tools-list.baseline.json`, which must
   never be regenerated. A new tool is a new baseline entry; a *changed*
   description needs an explicit allowance in `mcp.test.mts` saying what
   changed and why

### Dependency Updates in Pull Requests

When submitting pull requests:

1. **Check dependency alignment** with MCP SDK before submitting
2. **Include dependency changes** in a separate commit when possible
3. **Document any deviations** from MCP SDK versions with clear reasoning
4. **Test thoroughly** after dependency updates to ensure compatibility

### Security Considerations

- Always use the `--` separator when passing user-provided arguments to shell commands
- Validate all inputs using Zod schemas
- Use `execFileAsync` with `shell: false` to prevent command injection
- Follow the existing patterns for UDID validation and path handling

For more security context, see the command injection resources in [CONTEXT.md](CONTEXT.md).

## Testing Requirements

Three layers, and they answer different questions. Run them in cost order — a
cheap failure is worth finding first.

### 1. Unit tests — `npm test`

Both packages: the library's pure logic (pruning rules, label matching,
coordinate transforms, recovery decisions) and the server's rendering, sessions
and tool wiring against a fake `Simulator` handle.

```bash
npm test        # both packages
npm run typecheck
```

No simulator, no companion, no build step; seconds. **Run it on every change**,
and extend it whenever you change a rule in `packages/simgadget/src/ax/` or a
string in `packages/simgadget-mcp/src/render.ts`. It needs Node ≥ 22.6, which
runs the TypeScript directly; the published packages still support Node 18.

The fake handle is **tethered to the real one by the compiler**: it is declared
as implementing a `Pick<Simulator, …>`, so a signature change in the library
breaks the test build instead of the server at runtime. Never widen it with
`any` — that throws the whole guarantee away.

### 2. The library end-to-end suite — `npm run test:e2e`

```bash
npm run test:e2e
```

~110 seconds, unattended, from a cold start. It creates two throwaway
simulators against the `testapp/` fixture, deletes them in `after()` including
on failure, and never touches a simulator it did not create. This is the layer
that answers whether the library actually drives a device — the fake companion
cannot tell you whether an AXBridge read really does see inside a toolbar. See
[TESTING_LIBRARY.md](docs/testing/TESTING_LIBRARY.md).

### 3. The companion checks — `npm run check:companion -- <udid>`

Six things this codebase believes about somebody else's binary, none of which
upstream has promised to keep, and all of which are invisible while they hold.
**Run it after bumping `companion.lock.json` or the submodule**, before
trusting the new binary. See [TESTING_TOOLS.md](docs/testing/TESTING_TOOLS.md) Part 5.

### 4. Manual testing

The server as an agent meets it — parity of response text, transports,
sessions — is not covered by anything cheaper, so **manual testing is required**
for changes that touch it:

### Why Manual Testing?

- Requires a real macOS device
- Needs a running iOS simulator
- Requires an MCP client with a real LLM
- Limited development budget (hobby project without sponsorship)

### Testing Process

1. **Build your changes**

   ```bash
   npm run build
   ```

2. **Configure your MCP client** (e.g., Cursor) to use your local build:

   ```json
   {
     "mcpServers": {
       "simgadget": {
         "command": "node",
         "args": ["/full/path/to/your/checkout/packages/simgadget-mcp/build/index.js"]
       }
     }
   }
   ```

3. **Start an iOS simulator**

   ```bash
   xcrun simctl list devices
   xcrun simctl boot "iPhone 15"  # or your preferred device
   ```

4. **Test thoroughly in your MCP client**
   - Test all affected functionality
   - Test error conditions
   - Verify the tool works as expected with AI agents
   - Run [TESTING_TOOLS.md](docs/testing/TESTING_TOOLS.md) to ensure existing functionality still works, and [TESTING_SERVER.md](docs/testing/TESTING_SERVER.md) for transport or session changes

### Required Documentation for Contributions

Include in your pull request:

- **Step-by-step testing instructions**
- **Screenshots or video** of the functionality working
- **Description of the real use case** that drove this change
- **Confirmation that existing functionality still works**

## Submitting Changes

1. **Create a feature branch**

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following the guidelines above

3. **Test thoroughly** using the manual testing process

4. **Update documentation** if needed:

   - Add new tools to README.md and AGENT_INSTRUCTIONS.md
   - Add a step to [TESTING_TOOLS.md](docs/testing/TESTING_TOOLS.md) — required if the change is a bug fix, per
     the regression rule above
   - Update any other relevant documentation

5. **Submit a pull request** with:
   - Clear description of the change and motivation
   - Step-by-step testing instructions
   - Screenshots/video of manual testing
   - Confirmation of real use case

## Release Process

- Releases are managed through the GitHub releases page
- The pipeline uses standard `npm publish` commands
- **Both packages move in lockstep** — same version number, `simgadget`
  published first because `simgadget-mcp` depends on it at that exact version.
  This publishes some meaningless server bumps and in exchange nobody ever
  reasons about version skew
- Version bumping and release timing are handled by the maintainer

## Questions or Discussions

For significant changes or questions:

- Open a GitHub issue for discussion
- Reach out via DMs for architectural discussions
- Provide context about your specific use case

## Code of Conduct

- Be respectful and constructive in all interactions
- Focus on real use cases and practical solutions
- Respect the project's philosophy of intentional simplicity
- Provide thorough testing and documentation for contributions

Thank you for helping make SimGadget better! 🚀
