# Reveal - agent guide

Class-driven scroll reveals. The JS decides *when* an element has arrived; the CSS decides
what that looks like. Nothing is animated from JavaScript. Styling is classes (`reveal`
marker + `reveal-<effect>` + timing classes, each timing class one custom property);
data attributes are behavior only (`data-reveal-anchor`, `-once`, `-offset`,
`-anchor-placement`).

## Commands

- `npm run dev` / `npm run serve` - rollup watch + dev server on port 3004, serving `demo/`
- `npm run build` - ESM, UMD, minified UMD, and extracted CSS into `dist/`
- `npm test` - vitest (`test/`), `npm run test:watch` to keep it running
- `npm run lint` - ESLint over `src/`, `test/`, and the rollup config
- `npm run format` - Prettier over `src/`, `demo/index.html`, and the rollup config

`dist/` is committed, and `demo/` holds a copy of `dist/reveal.esm.js`, its map and
`reveal.min.css`. Rebuild **and re-copy** both with any `src/` change:

```sh
npm run build && cp dist/reveal.esm.js dist/reveal.esm.js.map dist/reveal.min.css demo/
```

## Layout

```
reveal/
├── src/
│   ├── reveal.js         - RevealController + the module's exports (ESM entry)
│   ├── observe-cross.js  - trigger-line detection: placements, staging, observers
│   ├── attributes.js     - pure parsers for the behavior data-reveal-* attributes
│   ├── utils.js          - element and offset resolution
│   ├── reveal.css        - resting states, effects, .is-revealed, reduced motion
│   ├── reveal.tailwind.css - the Tailwind build: every rule a @utility
│   └── umd.js            - UMD entry, so the global is the default-export object
├── test/                 - vitest: placement math, offsets, attribute parsing, SSR guard
├── demo/index.html       - the showcase page, and the manual test bed
├── dist/                 - committed build output
└── rollup.config.mjs
```

**Zero runtime dependencies, and it stays that way.** `observe-cross.js` and `utils.js`
started life in `@magic-spells/scroll-trigger` and were copied in deliberately - reveal is
the package people install, so it carries its own copy rather than dragging a scroll-spy
along. Fixes belong here; there is no upstream to sync with.

## How it works

1. `init()` bails out under Node, when `disable` resolves truthy, under
   `prefers-reduced-motion: reduce`, and when IntersectionObserver is missing. Bailing means
   **adding** `reveal-off` to `<html>` so nothing is left hidden - including elements the
   consumer appends later. A reduced-motion change listener re-runs `init()` when the setting
   flips, though the stylesheet's own media query already covers that case without any JS.
2. Elements are grouped by `offset | once | placement` - the three things that decide where a
   trigger line sits. Each group gets one `observeCross` call.
3. Inside a group, elements are keyed by their **trigger element**: themselves, or the
   `data-reveal-anchor` target. Several elements sharing an anchor reveal on one crossing.
4. A crossing adds `is-revealed`. Staggering is entirely CSS `transition-delay`, which is why
   an anchor group can fire at one instant and still cascade.

## Trigger geometry - the part to be careful with

**Crossings are decided on the layout box, never the painted one.** `#measureBox()` reads
`offsetHeight` and walks the offsetParent chain (AOS's `getOffset`), both of which ignore
transforms. `getBoundingClientRect()` does not, and using it means an element's own resting
transform moves its own trigger line: `fade-up` fires `--reveal-distance` late,
`bottom-bottom` measures a zoomed height, and a `once: false` element parked within that
distance of its line oscillates forever - reveal, `transform: none` pushes it back over the
line, un-reveal, transform returns, repeat.

IntersectionObserver is only the wake-up, and it *does* see the transform. Four things keep
the two in agreement:

- **Shift compensation.** `state.shift` is the measured gap between the painted top and the
  layout top. Each observer's boundary is aimed at `line + shift`, so it flips exactly when
  the layout box crosses.
- **A pre-arm stage.** Every element first sits on one coarse observer `PREARM_BAND` px below
  its real line. The shift can only be measured before the element can possibly cross, and
  heights read before styles settle are wrong. Measuring there covers both.
- **A settle stage.** A state change starts a transition, and the painted box is meaningless
  until it ends: an observer's mandatory initial record arrives mid-flight, and recording that
  transient would aim the reverse boundary at a place the element never rests. `#settle()`
  waits the transition out (`transitionend` for the longest-running property, with the
  computed duration+delay as the timeout), then **re-measures** and re-aims. Re-measuring
  rather than assuming `shift = 0` when revealed is what makes a persistent *ancestor*
  transform work - the measurement contains the ancestor's displacement and excludes the
  element's own finished one. Shift recording is suppressed while `state.settling`.
- **Self-correction.** If an observer wakes us on the wrong side of the layout check
  (`entry.isIntersecting !== crossed`) and nothing is in flight, its boundary is stale - re-aim
  it at the freshly measured shift instead of firing.

`#measureBox()` returns `null` for anything that cannot be placed: no layout box at all
(`display:none`, a closed `<details>`), or a zero height under an element-edge placement (an
image that has not loaded). Those elements are **not** crossed and **not** retired - they stay
on the pre-arm observer, and the observer fires again when they gain a box.

Two geometries are deliberately not the layout one:

- **No offsetParent chain** (fixed position, SVG): there is no scroll position at which the
  element arrives, so it is crossed on first evaluation and retired. Predictable beats never.
- **Inside a scrolling container** (`hasScrollableAncestor`): the layout walk cannot see a
  static `overflow:auto` ancestor, so an element scrolled inside one reports a position that
  never moves and every wake-up gets denied. Those elements fall back to painted geometry,
  which is transform-aware - the documented trade, and the reason repeat mode inside a
  scroller is unsupported.

An element-edge placement also gets its **own** ResizeObserver entry: a target shrinking inside
a fixed-height parent never changes the document's size, so the document entry alone would
leave `bottom-bottom` aimed at a stale height.

## Rules

- **Resting states apply unconditionally; the library un-hides.** `.reveal` is hidden
  from the first paint with no snippet in `<head>`. The escape hatch is `html.reveal-off`,
  which outranks every rule including `.is-revealed` - never write a hiding rule that can beat
  it. One malformed element (an invalid `data-reveal-anchor` selector is the classic) must
  never stop the rest from being armed - hence the try/catch around each element and around
  `#observe()`, and the `reveal-off` fallback in `init()`'s catch.
- **Reduced motion is CSS-first.** The media query at the bottom of `reveal.css` repeats the
  `:not(.reveal-done)` selector so it outranks the transition shorthand on specificity, not
  just source order. It works before the bundle loads; the JS bail-out is an optimization on
  top, not the thing correctness rests on.
- **`destroy()` un-hides; `#teardown()` does not.** Public `destroy()` runs `#teardown()` and
  then adds `reveal-off`, because nothing is left running to reveal what had not arrived -
  anything below its trigger line becomes visible at that moment. `is-revealed` and
  `reveal-armed` are left alone; removing them would snap live content back.
- **`init()` is idempotent** - it calls `#teardown()`, **not** `destroy()`. Going through
  `destroy()` would add `reveal-off` and flash the whole page visible before `#arm()` took it
  back off. There is a test asserting the class is never added mid-init.
- **Timing is CSS custom properties.** Global values go on `documentElement`, and only when
  the caller passed them - an option dropped on a later `init()` has to stop applying, so the
  property is removed rather than left behind. Per-element values come from timing classes
  (plain build: delay 0-1000 step 50, duration 100-2000 step 100, five named easings) or an
  inline `--reveal-*` style for computed values. The JS never reads styling classes.
- **New effects need no JavaScript** - add a `.reveal-<name>:not(.is-revealed)` resting rule
  and it works - but add the matching `@utility reveal-<name>` to `src/reveal.tailwind.css`
  in the same commit, or Tailwind projects silently lose it. Both files, plus a demo card.
- **The two stylesheets are alternatives, never both.** Same class names in each:
  `reveal.css` is enumerated and ships whole; `reveal.tailwind.css` is all `@utility` and
  ships only what a project writes. Loading both duplicates every effect.
- **`.reveal` is the marker, and the only thing the collector matches.** `SELECTOR` is
  `.reveal`. An effect class on its own is deliberately not observed - there is no way for
  the JS to know the effect names without hard-coding them.
- **Tailwind utilities out-rank each other by sort order, not source order**, so the utility
  file never writes an override pair. Resting states are `:not(.is-revealed)` and simply stop
  matching once the class lands, and the `reveal-off` and reduced-motion blocks are scoped
  under `html` so they win on specificity rather than on position.
- **Every timing class sets exactly one custom property** consumed by the single transition
  shorthand (opacity, transform, filter - filter is what blooms animate). Never generate a
  rule that sets `transition-delay`/`transition-duration` directly; the shorthand resets it.
- **Rebuilds are reentrancy-guarded and reconciled.** Reveal callbacks run synchronously inside
  `#observe()`, so consumer code reacting to `is-revealed` can land back in `refreshHard()`
  mid-rebuild; a nested call marks the pass dirty and returns, and the outer pass re-runs once
  on a microtask. Every new observer also starts at "not crossed", so `#reconcile()` clears
  `once: false` targets that are revealed but now below their line - nothing else would, since
  equality means no exit callback and teardown deliberately keeps classes.
- **`reveal-done` is timed per target, not per trigger.** An anchor says nothing about the
  duration or delay of the elements anchored to it, so reveal runs its own settle per element
  (through `whenSettled`) before releasing the transition shorthand.
- **Only a real state change acts, and the class is what says so.** `#setRevealed()` filters
  its targets on `classList.contains(REVEALED_CLASS) !== revealed` before doing anything,
  because a rebuild re-announces every crossing from "not crossed". Acting on those would
  restart settles, rewrite `--reveal-delay` mid-transition, and let revealed elements claim
  indices in a wave they are not part of. The discriminator has to be the class and never a
  private set: anything can take `is-revealed` off an element - a framework re-rendering the
  class attribute, an author replaying a reveal - and a controller holding its own opinion
  would call every later crossing a no-op with nothing, not `refreshHard()` and not
  `destroy()`/`init()`, able to argue it back. `#reconcile()` reads the same class, for the
  same reason.
- **A settle in flight is a debt teardown pays.** `reveal-done` is what releases the transition
  shorthand, and once `#teardown()` has run there is nothing left to add it - and the re-arm
  that follows sees no state change, so it starts no new settle either. `#teardown()` therefore
  calls each pending settle's own `finish` (stored in the record alongside the `cancel` closure
  `whenSettled` hands back) instead of cancelling it - `finish` cancels its own wait on the way
  through, so there is nothing left to cancel afterwards. `#settleTargets()` still *cancels* the
  settle it is replacing; only teardown completes. That makes `#teardown()` a method that writes a class, so it clears `#initialized`
  **first** - a consumer reacting synchronously must not be able to rebuild into a teardown
  still running.
- **A stagger wave is a task, and a rebuild ends it.** `#stagger()` numbers the members
  arriving together, and `#openWave()` holds the batch open on a `setTimeout(0)` - a microtask
  would close it between two observer callbacks describing one crossing. `#rebuild()` calls
  `#endWave()` so appended content starts a fresh cascade at `0ms`. A declared step of `0` is a
  real step (`step === undefined` is the absent check, never `!step`).
- **The controller only removes a delay it still owns.** `#staggered` is a WeakMap from an
  element to the **name of the group** that wrote its inline `--reveal-delay`; it survives
  `#teardown()` and `destroy()` exactly as that value does. Removal on the way out needs the
  recorded name to equal the element's *current* group name, not merely membership in some
  group: an element can leave the group that wrote the value - for no group at all, or for a
  different one - and be given a delay of its own before it ever exits, and wiping that would
  eat an author's value. A step-less group writes nothing and so removes nothing, which is
  exactly the group a swap most often lands in.

## Verifying

`npm test` covers the pure logic - the nine placements against AOS's own formula, offset
parsing, the offsetParent walk, scrollable-ancestor detection, attribute parsing, the no-window
guard - plus a jsdom suite driving the real code against a stubbed IntersectionObserver and
stubbed element geometry (`test/observer.test.js`): staging promotion, a throwing callback not
stranding its batch, rebuild reconciliation, the reentrancy guard, and no live observer left
after `destroy()`. Add to that suite rather than reaching for the browser when the behaviour
can be expressed in geometry.

The rest is a browser matter. Open the demo (`npm run dev`) and check:

- every effect animates in, and the delay cards cascade
- the anchor-group cards fire on the dark band's crossing, not on their own positions
- `data-reveal-once="false"` cards hide again when scrolled back past
- the HUD's teardown buttons: `destroy` stops new reveals, `init` re-arms, `add` reveals a
  freshly appended card
- with `prefers-reduced-motion: reduce` set in the OS, everything is visible on load with no
  transition and no `is-revealed` classes - and toggling the setting re-arms the page live

When scripting checks, remember the demo sets `scroll-behavior: smooth`: set
`document.documentElement.style.scrollBehavior = 'auto'` first or every probe reads a
mid-flight scroll position. Compute expected trigger positions from the **layout** top
(`offsetTop` chain), not `getBoundingClientRect()`, or the resting transform will skew them.
