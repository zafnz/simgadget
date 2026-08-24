<a href="https://simgadget.dev"><img src="https://raw.githubusercontent.com/zafnz/simgadget/main/website/assets/banner.png" alt="SimGadget" width="100%"></a>

# simgadget-mcp

**Give every agent its own iPhone.** An MCP server that lets AI agents create,
control and destroy iOS simulators through session-based lifecycle management.
One server, many agents, many simulators, nobody stepping on anybody.

```bash
npx -y simgadget-mcp
```

There is no step two that involves installing `idb`. No `pipx install fb-idb`,
no `brew install idb-companion`, no Xcode command-line archaeology — the server
fetches a pinned, sha256-verified `idb_companion` on first use.

- **Website:** [simgadget.dev/mcp.html](https://simgadget.dev/mcp.html)
- **Want to drive a simulator from your own code instead?** That is
  [`simgadget`](https://www.npmjs.com/package/simgadget), the library this server
  is built on. It ships without the MCP SDK and Zod, which are 14 MB between them.

## Requirements

- **macOS on Apple Silicon.** iOS simulators are macOS-only and the pinned
  companion is arm64-only.
- **Xcode**, with at least one iOS runtime installed.
- **Node.js 18+.**

---

## Setup, in full

HTTP is the default transport, because sessions live in the server process and
that is what lets several agents share it.

**1. Start the server.**

```bash
npx -y simgadget-mcp
```

**2. Point your agent at it.**

Claude Code:

```bash
claude mcp add --transport http simgadget http://127.0.0.1:8008/mcp
```

Cursor and other config-file clients (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "simgadget": {
      "type": "http",
      "url": "http://127.0.0.1:8008/mcp"
    }
  }
}
```

There is no step three. You do not need a `SKILLS.md` or a prompt preamble
either — the tool descriptions and server instructions are written for a model,
including when *not* to reach for the expensive tool.

### Sessions

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Agent A    │  │   Agent B    │  │   Agent C    │
│  (id: "qa1") │  │  (id: "qa2") │  │  (id: "dev") │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       └────────────┬────┴────┬────────────┘
                    │         │
              ┌─────┴─────────┴──────┐
              │    MCP Server        │
              │  (single process)    │
              └──┬─────────┬──────┬──┘
                 │         │      │
          ┌──────┴──┐ ┌────┴───┐ ┌┴────────┐
          │ iPhone  │ │ iPad   │ │ iPhone  │
          │ 16 Pro  │ │ Air    │ │ 16 Pro  │
          │ (qa1)   │ │ (qa2)  │ │ (dev)   │
          └─────────┘ └────────┘ └─────────┘
```

Every tool takes an `id` naming your session, and each session owns one
simulator. Because the state lives in the server rather than the client, a
simulator survives its agent disconnecting — call `start_simulator` again with
the same `id` and you resume where you left off. Owned simulators are destroyed
when the server itself shuts down, unless `SIMGADGET_CLEANUP_ON_EXIT=false`, so
a day's work does not leak twenty simulators.

Agents should pick a distinctive id (`"qa-login-flow"`, not `"test"`), because
sharing an id means taking over each other's simulator.

### Running the client in a container

The simulators live on the host — a container cannot run them — so the usual
shape is the server on the host and the client inside the container, reaching
out through Docker's host alias:

```bash
# on the host: listen where the container can reach it
npx -y simgadget-mcp --host 0.0.0.0 --port 8008
```

```json
{ "mcpServers": { "simgadget": {
  "type": "http", "url": "http://host.docker.internal:8008/mcp"
} } }
```

`host.docker.internal`, `gateway.docker.internal` and Podman's
`host.containers.internal` are accepted by default. Any other name — a proxy, a
LAN address, a hostname of your own — needs
`SIMGADGET_ALLOWED_HOSTS="that.name:8008"`.

This is also what lets agents run in the cloud against a Mac at home. Please put
a VPN or Tailscale in front of it if you do: binding to `0.0.0.0` exposes an
unauthenticated server to every network the host is on, so do it only on a
machine you trust, and prefer publishing the port to the container alone where
your setup allows it.

> **Security note:** the HTTP transport is unauthenticated and binds to
> `127.0.0.1` by default. Do not expose the port to untrusted networks — the
> server can create and control simulators, read screenshots, and write files.
>
> Requests are checked against an allowlist of `Host` headers, which stops a web
> page you happen to visit from pointing a hostname it controls at `127.0.0.1`
> and driving the server from your browser. A rejected request says so, lists
> what is accepted, and names `SIMGADGET_ALLOWED_HOSTS`.

### Stdio mode

Add `--stdio` if you want the old shape, where the client spawns its own private
server. Note that you lose multi-agent support: sessions live in the server
process, and with stdio every client has a different one.

```json
{
  "mcpServers": {
    "simgadget": {
      "command": "npx",
      "args": ["-y", "simgadget-mcp", "--stdio"]
    }
  }
}
```

---

## In practice

You describe the outcome; the agent picks the tools.

> **Launch the simulator and install my app.**

```
start_simulator { id: "qa1", type: "iPhone 16 Pro" }
install_app     { id: "qa1", app_path: "./build/MyApp.app" }
launch_app      { id: "qa1", bundle_id: "com.example.myapp" }
```

> **Enter a fake username and password, then tap login.**

```
ui_describe_all { id: "qa1" }              // what are the fields called?
ui_tap  { id: "qa1", label: "Email" }
ui_type { id: "qa1", text: "test@example.com" }
ui_tap  { id: "qa1", label: "Password" }
ui_type { id: "qa1", text: "hunter2" }
ui_tap  { id: "qa1", label: "Log In" }
```

> **Turn Sound on in settings — and make sure it actually took.**

```
ui_tap { id: "qa1", label: "Sound" }
‹ Toggled Sound off -> on.                 // read back, not assumed
```

> **Now try the stepper at the bottom of the list.**

```
ui_tap { id: "qa1", label: "Stepper" }
‹ Refused: "Stepper" resolved at (188, 604) but the touch would land on
  "Search" (SearchField). It is covered, off screen, or scrolled out of view.

ui_swipe { id: "qa1", x_start: 200, y_start: 600, x_end: 200, y_end: 300 }
ui_tap   { id: "qa1", label: "Stepper" }
‹ Tapped "Stepper" (Stepper) at (188, 304).
```

> **Does the settings screen look right in landscape?**

```
rotate  { id: "qa1", orientation: "landscape_left" }
‹ Rotated to landscape_left; the interface adopted landscape_left.

ui_view { id: "qa1" }                      // screenshot back to the model, right way up
```

**Pro tip:** you do not need a frontier model for this. Cheap fast models are
perfectly good at navigating an app and comparing screenshots — the tools do the
hard part. Haiku is nearly fast enough to record demo videos in real time.

[AGENT_INSTRUCTIONS.md](https://github.com/zafnz/simgadget/blob/main/AGENT_INSTRUCTIONS.md)
can be handed to an agent that wants more concrete examples, though the tool
descriptions are usually enough.

---

## Driving the UI

There are two ways for an agent to act on the screen, and picking the right one
is most of the difference between a cheap agent loop and an expensive one.

### When you know what you want: `ui_tap` and `ui_find`

```
ui_tap  { id: "qa1", label: "Sign Up" }
ui_find { id: "qa1", label: "Welcome back" }
```

The simulator resolves the element itself and returns only the match — about
**340 bytes**, versus 7–10 KB for a whole screen tree. `ui_tap` operates that
element, so the model never handles a coordinate. `ui_find` returns the element
without its subtree, and reports a miss as an ordinary answer rather than an
error, so an agent can branch instead of spiralling.

Matching is a case-sensitive substring match against the element's accessibility
label, its visible text, or its accessibility identifier; curly quotes,
apostrophes and dashes are folded to their plain equivalents. The first match
wins, so name things precisely — `ui_tap` replies with the element it acted on,
which is where a wrong match shows up.

`ui_tap` checks the touch will reach the element before sending it, so a control
that is covered, scrolled out of view or disabled is **refused** rather than
silently missed. That turns a whole class of "the test passed but nothing
happened" into an error the agent can react to. A switch is switched rather than
touched — its accessibility frame usually spans its whole row, so the centre is
not the control — and the reply carries the state read back:

```
› ui_tap { id: "qa1", label: "Toolbar Button" }
‹ Tapped "Toolbar Button" (Button) at (102, 822).

› ui_tap { id: "qa1", label: "Sound" }
‹ Toggled Sound off -> on.

› ui_tap { id: "qa1", label: "Stepper" }
‹ Refused: "Stepper" resolved at (188, 604) but the touch would land on
  "Search" (SearchField). It is covered, off screen, or scrolled out of view.

› ui_find { id: "qa1", label: "Checkout" }
‹ No element found matching "Checkout".
```

`ui_tap { x, y }` is always a plain touch, for when you want exactly that.

### When you need to look around: `ui_describe_all`

Use this when the agent does not yet know what is on screen. It returns a nested
JSON accessibility tree in logical coordinates, read from the app's real view
hierarchy — so nav bars, tab bars and toolbars have their contents — pruned to
elements you can act on.

### Seeing the screen: `ui_view`

`ui_view` returns a compressed screenshot, which is useful for *verifying* what
an app looks like. It is a poor choice for navigation: screenshots are in pixel
space while taps are in logical space, and the two do not line up once the
device is rotated. Navigate with labels or `ui_describe_all`; use `ui_view` to
check the result.

### And `start_simulator` waits

It does not return until the simulator answers, so the next tool call works. If
it runs out of budget it says so and hands back the UDID, rather than being
killed mid-wait by the client's timeout and telling you nothing.

---

## Tools

Seventeen. All take a required `id` (session identifier).

| Tool | Additional parameters | Description |
|---|---|---|
| `start_simulator` | `type?` (e.g. "iPhone", "iPad", "iPhone 16 Pro") | Creates, boots and opens a simulator for the session |
| `destroy_simulator` | — | Shuts down and deletes it — or merely detaches, if it was attached |
| `attach_simulator` | `udid` | Adopts an already-booted simulator by UDID |
| `rotate` | `orientation` (`portrait`, `landscape_left`, `landscape_right`, `upside_down`) | Rotates the device, then reports the orientation the interface actually adopted |
| `detect_rotation` | — | Re-probes orientation and updates the coordinate mapping |
| `ui_find` | `label` | Resolves one element by label, visible text or identifier |
| `ui_tap` | `label?`, `x?`, `y?`, `duration?`, `count?` | Operates an element by name, or taps at coordinates |
| `ui_describe_all` | — | The whole screen's accessibility tree (JSON), pruned to what you can act on |
| `ui_describe_point` | `x`, `y` | What is at these coordinates |
| `ui_type` | `text` | Types text into the focused field |
| `ui_swipe` | `x_start`, `y_start`, `x_end`, `y_end`, `duration?`, `delta?` | Swipe gesture |
| `ui_view` | — | Compressed screenshot as base64 JPEG, inline |
| `screenshot` | `output_path`, `type?`, `display?`, `mask?` | Saves a screenshot to a file |
| `record_video` | `output_path?`, `codec?`, `display?`, `mask?`, `force?` | Starts video recording |
| `stop_recording` | — | Stops the current recording |
| `install_app` | `app_path` | Installs a `.app` or `.ipa` on the simulator |
| `launch_app` | `bundle_id`, `terminate_running?` | Launches an app by bundle identifier |

Hide any of them from clients with `SIMGADGET_FILTERED_TOOLS`.

---

## Configuration

### Command-line flags

Precedence is flag, then environment variable, then default. Each value flag
also accepts the `--flag=value` form.

| Flag | Default | Environment variable | Description |
|---|---|---|---|
| `--port <n>` | `8008` | `SIMGADGET_HTTP_PORT` | Listen port in HTTP mode |
| `--host <addr>` | `127.0.0.1` | `SIMGADGET_HTTP_HOST` | Bind address |
| `--http` | default | `SIMGADGET_TRANSPORT=http` | Serve over HTTP |
| `--stdio` | — | `SIMGADGET_TRANSPORT=stdio` | Serve over stdio instead. One client per process; no shared sessions |
| `--transport <name>` | `http` | `SIMGADGET_TRANSPORT` | Long form of the two above |
| `--verbose`, `-v` | off | `SIMGADGET_VERBOSE` | Log activity to stderr |

### Environment variables

These have no flag. The last two are read by the library, and behave identically
whether you use it directly or through this server.

| Variable | Default | Description |
|---|---|---|
| `SIMGADGET_ALLOWED_HOSTS` | loopback + container host aliases | Extra `host:port` values accepted in the HTTP `Host` header, comma separated |
| `SIMGADGET_CLEANUP_ON_EXIT` | `true` | Delete simulators this server created when it exits |
| `SIMGADGET_DEFAULT_OUTPUT_DIR` | `~/Downloads` | Where screenshots and recordings land when a tool is given a relative path |
| `SIMGADGET_FILTERED_TOOLS` | — | Comma-separated tool names to hide from clients |
| `SIMGADGET_COMPANION_PATH` | pinned build | Use this `idb_companion` binary instead of the pinned one |
| `SIMGADGET_COMPANION_CACHE` | `~/Library/Caches/simgadget` | Where the downloaded companion is cached |

In HTTP mode these belong in the shell that starts the server, since that is the
process they configure — the client only holds a URL:

```bash
SIMGADGET_DEFAULT_OUTPUT_DIR=~/Code/project/tmp \
  npx -y simgadget-mcp --port 8008
```

In stdio mode, where the client spawns the server, set them in the `env` block
of your MCP client config instead.

**Migrating from `ios-multi-simulator-mcp`:** the old `IOS_SIMULATOR_MCP_*`
variable names are still read for two releases, with one deprecation line on
stderr naming the replacement.

### Verbose

`--verbose` shows clients connecting and their commands:

```
SimGadget MCP server listening on http://127.0.0.1:8008/mcp (verbose)
[2026-08-09T09:53:53.472Z] client 127.0.0.1:49630 connected
[2026-08-09T09:53:53.476Z] 127.0.0.1:49630 initialize
[2026-08-09T09:53:53.501Z] 127.0.0.1:49632 session "qa-a" start_simulator
[2026-08-09T09:53:54.900Z] 127.0.0.1:49632 session "qa-a" ui_tap
[2026-08-09T09:53:55.100Z] client 127.0.0.1:49630 disconnected
```

---

## The companion

Everything this server can do that `xcrun simctl` cannot — reading the
accessibility tree, tapping by name, hit-testing a touch before sending it —
rests on `idb_companion`. Facebook's last `idb` release was **2022**, and the
alternatives shell out to that, or to a Homebrew binary of the same vintage.

SimGadget pins its own: a build from current idb source against Xcode 26.6 /
Swift 6.3.3, sha256-verified and downloaded on demand the first time you need it
(~19 MB, cached afterwards). There is deliberately no fallback to an
`idb_companion` on `$PATH` — an old one ignores request fields it does not
understand instead of erroring, so a fallback would return results that are
wrong but entirely plausible.

To front-run the download in CI: `npx simgadget prefetch`.

## Troubleshooting

**Rotated screen** — screenshots are pixel space while taps use logical space,
so they do not align once rotated. Navigate with `ui_tap { label }` or a
describe instead; both use logical coordinates, and both cost fewer tokens
anyway.

**"I asked for `landscape_left` and the app says `landscapeRight`"** — both are
right. UIKit has two orientation vocabularies and crosses them deliberately:
`UIInterfaceOrientationLandscapeLeft` *is* `UIDeviceOrientationLandscapeRight`,
"because rotating the device to the left requires rotating the content to the
right". `rotate` and `detect_rotation` name the **device**, the same way the
Simulator's own Device > Orientation menu does.

**`rotate: "upside_down"` appears to do nothing on an iPhone** — the device does
turn, but no Face ID iPhone gives an app an upside-down interface, whatever its
`Info.plist` says. `rotate` tells you so, and reports the orientation the
interface actually kept. Use an iPad if you need that case.

**A tool you expected is missing** — MCP clients bind to the tool list at
connect time, so a tool added after the client connected is invisible to it.
Reconnect.

For everything else, see
[TROUBLESHOOTING.md](https://github.com/zafnz/simgadget/blob/main/TROUBLESHOOTING.md).

## More

- **[simgadget](https://www.npmjs.com/package/simgadget)** — the library underneath, if you would rather write code than a prompt
- **[AGENT_INSTRUCTIONS.md](https://github.com/zafnz/simgadget/blob/main/AGENT_INSTRUCTIONS.md)** — concrete examples to hand an agent
- **[TESTING_TOOLS.md](https://github.com/zafnz/simgadget/blob/main/docs/testing/TESTING_TOOLS.md)** — the manual test plan covering every tool
- **[SECURITY.md](https://github.com/zafnz/simgadget/blob/main/SECURITY.md)** — security policy
- **[CHANGELOG.md](https://github.com/zafnz/simgadget/blob/main/CHANGELOG.md)** — release history

## License

MIT. Forked from [joshuayoes/ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp)
— all foundational work by Joshua Yoes.
