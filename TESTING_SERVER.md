# Testing the server

Transports, multiple sessions on one server, and process lifecycle.

For the tools themselves, see [TESTING_TOOLS.md](TESTING_TOOLS.md) — nothing here repeats it, so if a tool misbehaves this guide will not be what catches it.

**A human has to run these.** They need two MCP clients, a terminal, and Ctrl-C on a foreground process; an agent calling tools cannot drive any of it.

---

## Setup: a shared server

HTTP is the default transport, so a plain start is a shared server:

```bash
node packages/simgadget-mcp/build/index.js --port 8008
```

**Expected:** logs `SimGadget MCP server listening on http://127.0.0.1:8008/mcp`.

> `scripts/imsmd.sh` waits for the substring `listening on` in
> `/tmp/simgadget-daemon.log`. If that sentence is ever reworded, `start` stops
> waiting and reports success early.

Point clients at it as a remote server — **not** the `command`/`args` stdio form:

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

The server reports itself to clients as `simgadget`; the key above is yours to
name. A client that still has an `ios-multi-simulator` key pointing at a URL
works exactly the same — only the display name changed.

---

## Two agents, two simulators, one server

The reason this fork exists. Needs two separate MCP client windows against the **same** server.

1. In client A: `start_simulator` with `id: "agent-a"`, `type: "iPhone"`.
2. In client B: `start_simulator` with `id: "agent-b"`, `type: "iPad"`.

   **Expected:** a different simulator — different UDID, iPad rather than iPhone. Two simulator windows are open.
3. In A: `ui_describe_all` with `id: "agent-a"`. In B: the same with `id: "agent-b"`.

   **Expected:** each describes its own device. Neither disturbs the other.
4. In A: `ui_describe_all` with `id: "agent-b"`.

   **Expected:** it works. Sessions are not isolated from each other — one server, shared state. This is current behaviour, not a bug; see the security note in the README.
5. In each client: `destroy_simulator` with its own `id`.

   **Expected:** each simulator shuts down and is deleted independently.

## Disconnect and resume

An agent that dies mid-task should be able to pick its simulator back up.

1. In a client: `start_simulator` with `id: "resume-test"`. Note the UDID. Then `launch_app` to put it somewhere recognisable.
2. Fully quit the client. **Leave the server running.**
3. Reopen the client, or start a different one, pointed at the same URL.
4. `start_simulator` again with the same `id: "resume-test"`.

   **Expected:** `Resumed existing simulator for session "resume-test": ...`, with the **same UDID**. A new simulator here is a failure.
5. `ui_describe_all` with `id: "resume-test"`.

   **Expected:** the app from step 1 is still open.
6. `destroy_simulator` to clean up.

## Transport selection

1. **Default is HTTP:**

   ```bash
   node packages/simgadget-mcp/build/index.js
   ```

   **Expected:** logs a listening URL.
2. **`--stdio` selects stdio:**

   ```bash
   node packages/simgadget-mcp/build/index.js --stdio
   ```

   **Expected:** no listening line; the process speaks MCP on stdin/stdout. A client configured with the `command`/`args` form drives it, and `start_simulator`, `ui_describe_all` and `destroy_simulator` all behave as they do over HTTP.
3. **A flag beats the environment**, both ways:

   ```bash
   SIMGADGET_TRANSPORT=stdio node packages/simgadget-mcp/build/index.js --http --port 8009
   SIMGADGET_TRANSPORT=http  node packages/simgadget-mcp/build/index.js --stdio
   ```

   **Expected:** HTTP for the first, stdio for the second.
4. **Port is taken from `--port`, then `SIMGADGET_HTTP_PORT`, then 8008.**

## Cleanup on exit

Simulators the server created are its responsibility; ones it merely attached to are not.

1. With a server running, `start_simulator` with `id: "cleanup-test"`, then stop the server with Ctrl-C.

   **Expected:** the simulator is shut down and deleted — gone from `xcrun simctl list devices`.
2. Repeat with cleanup disabled:

   ```bash
   SIMGADGET_CLEANUP_ON_EXIT=false node packages/simgadget-mcp/build/index.js
   ```

   **Expected:** after Ctrl-C the simulator is **still present and booted**. Delete it by hand afterwards.
3. Attach to a simulator the server did not create (`attach_simulator`), then stop the server.

   **Expected:** that simulator survives, whatever the cleanup setting. The server only deletes what it owns.

## An empty point is not a wedged bridge

idb reports **one** error for two unrelated conditions: an accessibility bridge
that is not answering, and a point read that found nothing. The second is an
ordinary answer, and mistaking it for the first would have a caller's bridge
restarted for tapping an empty patch of screen. Run the server verbose — but see
TODO #100: recovery no longer logs, so the log half of this check is currently
vacuous and the **timing** is what carries it. A restart costs seconds; a point
read that answers in tens of milliseconds did not order one.

1. `start_simulator` with `id: "wedge-test"`, install and launch `testapp/`, then
   `ui_find "Plain Button"` and `ui_describe_point` at the centre of its frame.

   **Expected:** both resolve to the button. The successful read is also what
   marks the simulator as having answered, without which recovery deliberately
   does nothing.
2. `ui_describe_point` somewhere empty — `{x: 200, y: 600}` on that screen.

   **Expected:** an ordinary answer rather than an error (deliberate change 5),
   in tens of milliseconds, and **nothing about restarting anything in the log**.
   A restart here is the failure this step exists to catch, and it is the whole
   point of the step — the reply's wording is not.

   Today that answer is the four characters `null`. The spec asks for a
   sentence —

   ```
   No accessibility element at (200, 600). The simulator is answering normally,
   so that point is empty or covered — check the coordinates against ui_describe_all.
   ```

   — and the gap between the two is **TODO #92**, open and undecided. Read
   `null` as the current behaviour, not as this step failing.

## Recovering a wedged accessibility bridge

A simulator can keep rendering and answering taps while every accessibility read
fails forever, and it happens on its own to roughly one fresh simulator in four
(see [BOOT_BUG.md](BOOT_BUG.md)).

**There is no known way to induce it on demand, so this cannot be a scripted
step.** Stopping the guest's bridge is not it: `xcrun simctl spawn <udid>
launchctl stop com.apple.CoreSimulator.bridge` was measured to have launchd
bring the service straight back, with the next read simply waiting ~700ms and
succeeding — no wedge, nothing to recover. The real fault is a bridge that is
*running and not translating*, which stopping a healthy one does not produce.

What to do instead: when you meet one — a session where every accessibility read
suddenly fails with "no translation object" while taps and screenshots still
work — check that it cures itself. Any of `ui_tap {label}`, `ui_find`,
`ui_describe_point`, `ui_describe_all` or `ui_view` should recover it, since they
share one path.

**Expected:** the call that triggered it returns its answer rather than an
error, after a pause of a few seconds. That is the whole observable — see the
warning below.

> **The recovery is now silent, and this is a finding rather than a design.**
> The old server logged three lines through `vlog` — `simulator <udid> stopped
> answering accessibility; restarting com.apple.CoreSimulator.bridge`, `…
> recovered 11s after restarting …`, and `… a bridge restart; not restarting
> again` when the cooldown refused. The recovery moved into the library, which
> has no logging seam and writes none of them, and no row of "Deliberate
> behaviour changes" records the loss. **TODO #100.** Until that is settled,
> the only evidence a restart happened is the delay and the eventual answer;
> the cooldown and the failure path have no observable at all.

## Port already in use

1. With a server running on 8008, start a second one on the same port.

   **Expected:** it exits with a message naming the port and suggesting `--port`, rather than a raw `EADDRINUSE` stack trace — and it exits **1**, not 0. A configuration failure that exits 0 as the event loop drains is indistinguishable from a clean stop to anything supervising the process.
