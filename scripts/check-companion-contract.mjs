#!/usr/bin/env node
/**
 * Checks the things this server assumes idb_companion does.
 *
 * Not a test of our code — `npm test` covers that, and cannot reach a
 * companion. These are behavioural contracts with somebody else's binary, each
 * one load-bearing for a decision in `src/`, and none of them is written down
 * anywhere upstream promises to keep. idb is under active development; a change
 * to any of them would leave this server quietly doing the wrong thing rather
 * than failing, because every one of these assumptions is invisible when it
 * holds.
 *
 * Run it after bumping `companion.lock.json` or the submodule, and before
 * trusting a new companion:
 *
 *   npm run build
 *   testapp/build.sh
 *   # install and launch the fixture on a booted simulator, main screen
 *   node scripts/check-companion-contract.mjs <udid>
 *
 * It spawns its own companion for that udid, which is fine alongside the
 * server's — that is how every probe in this project has been run — and it only
 * reads, apart from one switch it toggles and toggles back, and one button
 * whose whole effect is a line of text in the fixture's own status label.
 */
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { companions } = require(path.join(REPO, "build/idb/companionManager.js"));
const idb = require(path.join(REPO, "build/idb/generated/idb.js"));

const Format = idb.AccessibilityInfoRequest_Format;
const Backend = idb.AccessibilityInfoRequest_Backend;
const Key = idb.AccessibilityActionRequest_SearchableKey;

const udid = process.argv[2];
// The remote-host assumption needs a screen the others cannot run on: a sheet
// or picker has to be up, which covers the fixture the rest are phrased
// against. So it is its own mode rather than a check that quietly skips.
const remoteOnly = process.argv.includes("--remote");
if (!udid) {
  console.error(
    "usage: node scripts/check-companion-contract.mjs <udid> [--remote]\n" +
      "  default:  the fixture (testapp) must be showing its main screen\n" +
      "  --remote: a remote-hosted view must be up — the photo picker, or the\n" +
      "            autofill sheet from TESTING_TOOLS.md Part 3"
  );
  process.exit(2);
}

let failures = 0;
const record = (pass, name, detail) => {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`        ${detail}`);
};

/** Every element in a tree, in the order the companion serialised them. */
function flatten(node, out = []) {
  if (!node || typeof node !== "object") return out;
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

const marker = (client, value, key = Key.LABEL, backend) =>
  client.accessibilityInfo({ marker: value, matchKey: key, backend });

await companions.withClient(udid, async (client) => {
  const bridgeTree = async () => {
    const t = await client.accessibilityInfo({
      format: Format.NESTED,
      backend: Backend.AXBRIDGE,
    });
    return (Array.isArray(t) ? t : [t]).flatMap((r) => flatten(r));
  };

  // --- The remote-host boundary, which needs a screen of its own. ----------
  // `translateRemoteSubtrees` keys on this node type to rebase a hosted view's
  // contents into screen coordinates. If the type changes, the translation
  // silently stops happening and taps inside sheets go back to landing
  // hundreds of points away — the bug that started all of this.
  if (remoteOnly) {
    const boundaries = (await bridgeTree()).filter((e) => e.type === "83");
    record(
      boundaries.length > 0,
      'a remote-hosted view restarts its coordinate space at a node of type "83"',
      boundaries.length
        ? `${boundaries.length} boundary node(s) found`
        : `none found — either no remote view is on screen (open the picker or the ` +
          `autofill sheet), or the type has changed and translateRemoteSubtrees ` +
          `no longer recognises it`
    );
    return;
  }

  // --- The fixture is what every check below is phrased against. -----------
  const screen = await client.accessibilityInfo({ format: Format.NESTED });
  const roots = Array.isArray(screen) ? screen : [screen];
  const all = roots.flatMap((r) => flatten(r));
  const labelled = (text) =>
    all.filter((e) => typeof e.AXLabel === "string" && e.AXLabel.includes(text));

  if (!labelled("Plain Button").length) {
    console.error(
      "The fixture is not on screen: no element labelled 'Plain Button'.\n" +
        "Install testapp and launch it on its main screen first, or pass\n" +
        "--remote to check the remote-hosted-view assumption instead."
    );
    process.exit(2);
  }

  // --- 1. Matching is substring, not exact. --------------------------------
  // `ui_find` and `ui_tap {label}` are documented as substring matches, and the
  // tool descriptions tell agents to "ask for what you see on screen". If this
  // became exact, every partial name an agent uses would stop resolving.
  {
    const hit = await marker(client, "Plain Butt");
    const found = hit?.elements?.AXLabel;
    record(
      found === "Plain Button",
      "a marker matches a substring, not just an exact label",
      `marker "Plain Butt" -> ${JSON.stringify(found ?? null)}`
    );
  }

  // --- 2. A marker resolves to the FIRST match, in serialisation order. -----
  // This is why ambiguity cannot be detected on the fast path, and therefore
  // why `matchInTree` ranks candidates only on the fallback and why `ui_tap`
  // names what it tapped. If upstream ever ranked, or returned all matches,
  // both of those could be reconsidered — see TODO #64b/#64c.
  {
    const matches = labelled("Plain");
    const hit = await marker(client, "Plain");
    const got = hit?.elements?.AXLabel;
    const first = matches[0]?.AXLabel;
    record(
      matches.length > 1 && got === first,
      "a marker returns the first match in tree order",
      `${matches.length} elements contain "Plain"; first is ${JSON.stringify(first)}, marker returned ${JSON.stringify(got ?? null)}`
    );
  }

  // --- 3. A marker returns one element, never a collection. -----------------
  // `findByLabel` reads `found.elements` as a single element. An array here
  // would be silently mis-parsed rather than rejected.
  {
    const hit = await marker(client, "Plain");
    const element = hit?.elements;
    record(
      element != null && !Array.isArray(element),
      "a marker returns a single element, not a list",
      `typeof elements = ${Array.isArray(element) ? "array" : typeof element}`
    );
  }

  // --- 4. The default backend cannot see system chrome; AXBridge can. -------
  // The entire reason `findByLabel` has a fallback, and that it costs ~300ms
  // only on a miss. If the default backend ever gained this, the fallback
  // becomes dead weight; if AXBridge lost it, toolbars go unreachable again.
  {
    let axSaw = true;
    try {
      const hit = await marker(client, "Toolbar Button");
      axSaw = !!hit?.elements;
    } catch {
      axSaw = false;
    }
    let bridgeSaw = false;
    try {
      const hit = await marker(client, "Toolbar Button", Key.LABEL, Backend.AXBRIDGE);
      bridgeSaw = !!hit?.elements;
    } catch {
      bridgeSaw = false;
    }
    record(
      !axSaw && bridgeSaw,
      "the default backend misses toolbar contents that AXBridge finds",
      `default backend: ${axSaw ? "found it" : "missed it"}; axbridge: ${bridgeSaw ? "found it" : "missed it"}`
    );
  }

  // --- 5. A point read hit-tests, and is cheap. ----------------------------
  // `ui_describe_point` is documented as fast, and `ui_tap {label}` now spends
  // one of these verifying every tap. At AXBridge prices (~300ms) that check
  // would not be affordable and would have to be reconsidered.
  {
    const button = labelled("Plain Button").find((e) => e.frame?.width);
    const f = button.frame;
    const started = Date.now();
    const at = await client.accessibilityInfo({
      point: { x: Math.round(f.x + f.width / 2), y: Math.round(f.y + f.height / 2) },
      format: Format.LEGACY,
    });
    const ms = Date.now() - started;
    record(
      at?.AXLabel === "Plain Button" && ms < 100,
      "a point read hit-tests, and costs well under 100ms",
      `${ms}ms -> ${JSON.stringify(at?.AXLabel ?? null)}`
    );
  }

  // --- 6. accessibility_action's tap activates without a touch. ------------
  // `ui_tap {label}` on a toggle depends on this entirely: a switch's frame
  // spans its whole row, so there is no coordinate to aim at. Toggled back
  // afterwards, so the fixture is left as it was found.
  {
    const readSwitch = async () => {
      const hit = await marker(client, "Plain Switch");
      return hit?.elements?.AXValue;
    };
    const before = await readSwitch();
    const press = () =>
      new Promise((resolve, reject) => {
        client.client.accessibilityAction(
          idb.AccessibilityActionRequest.fromPartial({
            marker: "Plain Switch",
            matchKey: Key.LABEL,
            depth: 50,
            tap: {},
          }),
          (err, res) => (err ? reject(err) : resolve(res))
        );
      });
    let after = before;
    let error = null;
    try {
      await press();
      await new Promise((r) => setTimeout(r, 600));
      after = await readSwitch();
      if (after !== before) {
        await press();
        await new Promise((r) => setTimeout(r, 600));
      }
    } catch (e) {
      error = e.message.slice(0, 120);
    }
    record(
      !error && after !== before,
      "accessibility_action activates a switch without a touch",
      error ? `error: ${error}` : `AXValue ${JSON.stringify(before)} -> ${JSON.stringify(after)} (restored)`
    );
  }

  // --- 7. An absent marker fails with "found no element". -------------------
  // `findByLabel`/`findByIdentifier` (index.ts) match this wording to tell an
  // empty result from a real failure, and turn it into a `null` — which
  // `tap({label})` turns into `ElementNotFoundError`. If the wording changes,
  // absence becomes a thrown gRPC error and every lookup in the library breaks.
  {
    let message = null;
    try {
      await marker(client, "Definitely Not On Screen — Contract Check 7");
    } catch (e) {
      message = e.message;
    }
    record(
      message !== null && /found no element/i.test(message),
      'an absent marker fails with "found no element"',
      message ? `-> ${JSON.stringify(message)}` : "no error was thrown"
    );
  }

  // --- 8. A point read with nothing there fails with "no translation object" —
  // the *same* text a wedged bridge produces (BOOT_BUG.md). This is the whole
  // reason `describePoint` (index.ts ~330-345) disambiguates by asking for the
  // screen before treating a failure as a wedge: an ordinary caller tapping an
  // empty patch of screen would otherwise have the simulator's bridge restarted
  // underneath them.
  //
  // The point is the gap the stack view's spacing leaves between two known
  // controls — chosen from the layout, not from the outcome, so this cannot
  // quietly start passing by finding some other empty spot.
  //
  // **Only this half of the belief is checkable, and deliberately so.** The
  // symmetric half — that a wedged bridge produces the same text — cannot be
  // manufactured on demand, because the only recipe available is
  // `simctl spawn <udid> launchctl stop com.apple.CoreSimulator.bridge`, and
  // that is the *cure*, not the disease: launchd answers it by bringing a fresh
  // bridge straight up. Measured three ways on iOS 26.5 with the pinned
  // companion, 2026-08-16 — 250ms polling over 15s, 98 sequential reads over
  // 8s, and 300 concurrent reads staggered across the stop — all with zero
  // failures, while `launchctl list` confirmed the bridge pid really did change.
  // There is no observable window to sample. The wedge in BOOT_BUG.md is a
  // bridge that never recovers on its own, which no deliberate stop reproduces.
  //
  // That costs nothing here, because this half is the load-bearing one: it
  // establishes that `isWedgeError` alone *cannot* tell the two apart, which is
  // exactly what makes the disambiguation necessary. See TODO #69.
  let emptyPointMessage = null;
  {
    const btn1 = labelled("Plain Button").find((e) => e.frame?.width);
    const btn2 = labelled("Disabled Button").find((e) => e.frame?.width);
    let detail;
    if (btn1?.frame && btn2?.frame) {
      const gapX = Math.round(btn1.frame.x + btn1.frame.width / 2);
      const gapTop = btn1.frame.y + btn1.frame.height;
      const gapBottom = btn2.frame.y;
      const gapY = Math.round(gapTop + (gapBottom - gapTop) / 2);
      try {
        const hit = await client.accessibilityInfo({
          point: { x: gapX, y: gapY },
          format: Format.LEGACY,
        });
        detail = `point (${gapX}, ${gapY}), the gap between Plain Button and Disabled ` +
          `Button, unexpectedly hit ${JSON.stringify(hit?.AXLabel ?? hit)}`;
      } catch (e) {
        emptyPointMessage = e.message;
        detail = `point (${gapX}, ${gapY}), the gap between Plain Button and Disabled ` +
          `Button -> ${JSON.stringify(emptyPointMessage)}`;
      }
    } else {
      detail = "could not locate Plain Button / Disabled Button frames to compute an empty gap";
    }
    record(
      emptyPointMessage !== null && /no translation object/i.test(emptyPointMessage),
      'a point read with nothing there fails with "no translation object"',
      detail
    );
  }


  // --- 9. `describe` returns screen dimensions in both pixels and points. ---
  // The coordinate contract's cached portrait point dimensions (spec decision
  // 6, DECISIONS.md) come from here rather than from an accessibility read, so
  // they are available before the bridge is driveable. Assert both units are
  // present and non-zero.
  {
    const description = await client.describe();
    const dims = description.screenDimensions;
    const ok =
      !!dims &&
      dims.width > 0 &&
      dims.height > 0 &&
      dims.widthPoints > 0 &&
      dims.heightPoints > 0;
    record(
      ok,
      "describe() returns screen dimensions in both pixels and points",
      dims
        ? `width=${dims.width} height=${dims.height} widthPoints=${dims.widthPoints} ` +
          `heightPoints=${dims.heightPoints} density=${dims.density}`
        : "screenDimensions missing from describe() response"
    );
  }

  // --- 10. A marker query at depth 0 searches only the root. ----------------
  // This is why `MARKER_DEFAULT_DEPTH` exists (src/idb/client.ts ~150-157): a
  // silent change here makes every deep control "not found". `IdbClient`
  // deliberately rewrites a falsy `depth` on a marker query to
  // `MARKER_DEFAULT_DEPTH`, so this has to bypass that and go to the raw gRPC
  // client to actually send depth 0 — going through the wrapper would silently
  // prove nothing.
  {
    const target = "Settings Switch"; // nested: scroll -> stack -> settingsRow -> switch
    const rawMarker = (depth) =>
      new Promise((resolve, reject) => {
        client.client.accessibilityInfo(
          idb.AccessibilityInfoRequest.fromPartial({
            format: Format.NESTED,
            marker: target,
            matchKey: Key.LABEL,
            depth,
          }),
          (err, res) => (err ? reject(err) : resolve(res))
        );
      });

    let foundAtDepth0 = false;
    let depth0Detail;
    try {
      const res = await rawMarker(0);
      const parsed = res?.json ? JSON.parse(res.json) : null;
      foundAtDepth0 = !!parsed?.elements;
      depth0Detail = foundAtDepth0 ? "found (unexpected)" : "absent, no error";
    } catch (e) {
      depth0Detail = `error: ${e.message.slice(0, 80)}`;
    }

    // Through the normal wrapped call — this is what `findByLabel` actually
    // issues, and it is what proves MARKER_DEFAULT_DEPTH is doing its job.
    let foundAtDefault = false;
    let defaultDetail;
    try {
      const hit = await marker(client, target);
      foundAtDefault = !!hit?.elements;
      defaultDetail = foundAtDefault
        ? JSON.stringify(hit.elements.AXLabel)
        : "absent (unexpected)";
    } catch (e) {
      defaultDetail = `error: ${e.message.slice(0, 80)}`;
    }

    record(
      !foundAtDepth0 && foundAtDefault,
      "a marker query at depth 0 searches only the root; the default depth reaches a deep control",
      `"${target}" at depth 0 -> ${depth0Detail}; at default depth -> ${defaultDetail}`
    );
  }

  // --- 11. A UNIQUE_ID marker matches a substring, exactly as a label does. -
  // Measured, not assumed, and the measurement contradicts the code:
  // `findByIdentifier` (index.ts ~172) is written as "exact, where a label is a
  // substring that can drift onto something else". It is not exact. The
  // companion's own refusal reads `found no element whose AXUniqueId contains
  // "..."`, and a marker of "lainSwitch" — not even a prefix — resolves to
  // `PlainSwitch`.
  //
  // Two call sites ride on this. `findByLabel` falls back to an identifier
  // lookup when the label misses (index.ts ~274), so a caller's partial name
  // can silently resolve an identifier it never spelled out; and `tap`'s toggle
  // read-back re-reads by identifier, which lands on the first element whose
  // identifier *contains* the one asked for rather than necessarily the one
  // tapped. Both resolve first-hit-in-tree-order (check 2), so neither can
  // report the ambiguity. If upstream ever makes UNIQUE_ID exact this goes red;
  // that would be a safer world, but the fake and those two sites have to be
  // told about it rather than find out in production.
  //
  // The control case is what stops this proving nothing: an exact identifier
  // must resolve too, or a substring miss would look the same as a broken query.
  {
    const probe = async (value) => {
      try {
        const hit = await marker(client, value, Key.UNIQUE_ID);
        return { label: hit?.elements?.AXLabel ?? null };
      } catch (e) {
        return { error: e.message.slice(0, 120) };
      }
    };
    // A strict substring: no prefix or suffix match can explain a hit on this.
    const partial = await probe("lainSwitch");
    const exact = await probe("PlainButton");
    record(
      partial.label === "Plain Switch" && exact.label === "Plain Button",
      "a UNIQUE_ID marker matches a substring, not just an exact identifier",
      `"lainSwitch" (strictly inside PlainSwitch) -> ${JSON.stringify(partial.label ?? partial.error)}; ` +
        `exact "PlainButton" -> ${JSON.stringify(exact.label ?? exact.error)}`
    );
  }

  // --- 12. The action API reports an unreachable element with "found no
  // element" too — the same wording a read uses (check 7). ------------------
  // `AccessibilityActionRequest` has no `backend` field, so an action always
  // runs on the default backend: the one blind to toolbar and nav-bar contents
  // (check 4). A toolbar switch is therefore findable through AXBridge and not
  // activatable, and `ui_tap {label}` depends on recognising exactly this to
  // fall back to a real touch. If the wording drifts, an unreachable element
  // becomes an opaque gRPC failure and a toolbar switch stops being tappable by
  // name — the failure mode check 7 guards against on the read path.
  //
  // The reachable half is what separates "unreachable" from "broken": Plain
  // Button is activated the same way, and its only effect is the fixture's own
  // status label.
  {
    const act = (value) =>
      new Promise((resolve, reject) => {
        client.client.accessibilityAction(
          idb.AccessibilityActionRequest.fromPartial({
            marker: value,
            matchKey: Key.LABEL,
            depth: 50,
            tap: {},
          }),
          (err, res) => (err ? reject(err) : resolve(res))
        );
      });

    let unreachable = null;
    try {
      await act("Toolbar Switch");
    } catch (e) {
      unreachable = e.message;
    }
    let reachable = null;
    let reachableError = null;
    try {
      reachable = await act("Plain Button");
    } catch (e) {
      reachableError = e.message.slice(0, 120);
    }
    record(
      unreachable !== null && /found no element/i.test(unreachable) && !reachableError,
      'an action on an element the default backend cannot reach fails with "found no element"',
      `"Toolbar Switch" -> ${JSON.stringify(unreachable ?? "no error was thrown")}; ` +
        `"Plain Button" (reachable) -> ${reachableError ? `error: ${reachableError}` : JSON.stringify(reachable ?? null)}`
    );
  }

  console.log(
    `\nThe remote-hosted-view assumption is not checked here — it needs a sheet on\n` +
      `screen. Open the picker (Show Picker) and re-run with --remote.`
  );
});

console.log(
  failures
    ? `\n${failures} assumption(s) no longer hold. Each one is load-bearing — see the\n` +
      `comment above the failing check for what depends on it.`
    : `\nAll assumptions hold.`
);
process.exit(failures ? 1 : 0);
