# SimGadget website — version 1

Three static pages. No build step, no framework, no dependencies — open
`index.html` in a browser and it works, or serve the directory anywhere.

```bash
python3 -m http.server 4321 --directory website/1
```

## Pages

| File | What it is |
|---|---|
| `index.html` | Landing: hero + demo, why it exists, four pillars, the bug dossier, the two packages, FAQ |
| `library.html` | `simgadget` — the pitch, every-action-returns-data, system requirements, **API reference** |
| `mcp.html` | `simgadget-mcp` — sessions + diagram, setup, **what you say / what it runs**, model ergonomics, the 17 tools, configuration |

Nav is Library / MCP server / GitHub. The bug dossier lives on the landing
page at `#fixes`; the footers and the "Bugs nothing else has fixed" card link
there.

**The library page is documentation, not a pitch**, past its first two
sections. The API reference is hand-written from `SIMGADGET.md` and carries a
visible **Placeholder** banner saying so — the intent is that generated docs
replace it, at which point that whole section becomes a link. Every group has
its own anchor (`#api-acting`, `#api-errors`, …) so the chips at the top and
any external links keep working if it's regenerated in place.

**The MCP configuration section is documentation too.** Flags first
(`--port`, `--host`, `--http`/`--stdio`, `--transport`, `--verbose`/`-v`,
verified against the current `parseArgs`), environment variables second, with
precedence stated: flag, then env, then default.

## Files

```
website/1/
├── index.html  library.html  mcp.html
└── assets/
    ├── site.css            the whole design system, ~700 lines, commented
    ├── site.js             theme toggle, copy buttons, video fallback
    ├── favicon.svg         ✅ real
    ├── logo.svg            ✅ real (also inlined in each page's nav/footer)
    ├── demo-poster.svg     ⚠️ placeholder
    ├── og-image.svg        ⚠️ placeholder — must be exported to PNG
    └── ASSETS.md           what to produce, with specs
```

## Design notes

**The look is an instrument, not a SaaS page.** Hairline rules with tick
marks, monospace numerals, measurements printed like readings off a bench.
The copy's whole argument is "here is a number, here is where it came from",
so the page is built to make numbers the loudest thing on it — hence the
`.stat` readings, and the `5 of 12 → 12 of 12` before/after motif on every
fix card.

**Two accents, and they mean something.** Mint is *measured / it worked*;
amber is *refused / the old way*. Nothing else is coloured. The stat rail,
the tick bullets, the `+` column of the versus block, and the `now` half of
every reading are all the same green on purpose.

**Light and dark both ship.** Light is warm paper (`#f4f2ed`), not white —
it reads as a lab notebook rather than a doc site. The page follows the
system by default; the sun button in the nav overrides it and the choice
sticks in `localStorage`. Both are defined as complete palettes, so neither
is a filter over the other.

**The hero demo degrades on purpose.** See below.

## The hero demo

The hero device frame holds a `<video>` pointed at `assets/demo.mp4`, which
**does not exist yet**. Behind it sits a CSS-animated stand-in: a fake
Settings screen where a tap indicator pings a switch, the switch flips, a
Sign Up button presses, and a confirmation slides in — on a 14-second loop,
synchronised with the wire log below it.

`site.js` watches the video. If it ever renders a frame, the stand-in is
hidden and the caption changes to "unedited screen capture". If the file is
missing, the `error` fires, the stand-in keeps playing, and nothing breaks.

**So: drop a real `assets/demo.mp4` in and the page picks it up with no
other change.** Spec is in `assets/ASSETS.md`.

The stand-in's tap indicators are rendered *inside* their target elements
rather than positioned with absolute pixel coordinates — an earlier version
used coordinates and drifted out of register the moment the fake app's rows
changed. If you edit the fake app's markup, the animation still lands.

Everything respects `prefers-reduced-motion`.

## Before this goes live

Content decisions I made that you should sign off on:

- **Port `8008` everywhere.** `WEB_PITCH.md` flagged this: the old README's
  install examples used `--port 54321`, but `8008` is the documented default
  (`IOS_SIMULATOR_MCP_HTTP_PORT`, README env table). The site is consistent
  on `8008`; make sure the shipped default agrees.
- **A `v1 · pre-release` chip sits in the nav** on all three pages. Neither
  package is published yet and the site describes them in the present tense,
  so the chip is doing real work. Delete the `<span class="chip-ver">` from
  each page at launch.
- **All GitHub/npm links point at `zafnz/simgadget`** and
  `npmjs.com/package/simgadget`, which is where the rename lands (SIMGADGET.md
  step 1). They 404 until it does.
- **No count is attached to the bug dossier.** The cards are unnumbered and
  the copy says "a pile of failures … the big ones are below", because the
  eight shown are a selection, not the total. Adding or removing a card needs
  no other edit.
- **I dropped these bits of the pitch copy:** the alternate hero lines (kept
  the main one), the ASCII multi-agent diagram (redrawn as SVG), and the
  "Claim sourcing / verify before launch" table, which reads as an internal
  note. Its *spirit* survives as one line under the dossier: every figure
  traces to a file in the repo.
- **I did not soften any number.** Everything quoted comes from `WEB_PITCH.md`
  and traces back to the changelog, `BOOT_BUG.md` or `companion.lock.json`.
  The pitch's own verify-before-publishing list still applies: re-measure a
  couple against the shipped library, confirm the dependency counts against
  what `npm install` actually reports, confirm `claude mcp add` syntax, and
  confirm `npx simgadget prefetch` shipped as specced.
- **The tool count is 17**, matching the tool list in CLAUDE.md. The tools
  table shows 15 rows because `record_video`/`stop_recording` and
  `install_app`/`launch_app` are paired.

## Browser support

Modern evergreen browsers. Uses `color-mix()`, `text-wrap: balance`,
`aspect-ratio` and `:has()`-free selectors. `text-wrap: balance` degrades to
normal wrapping; `color-mix()` is the only hard requirement and it is
Safari 16.2+ / Chrome 111+ / Firefox 113+.
