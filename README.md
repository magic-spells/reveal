# Reveal

Class-driven scroll reveals on IntersectionObserver. AOS-style effects as plain classes, CSS custom properties for timing, a Tailwind entry that generates only what you write, and a real `destroy()` for single-page apps. **Zero dependencies, 5.3 kB gzipped all in.**

```html
<div class="reveal reveal-fade-up">I fade up when I reach the trigger line.</div>
```

[**Live demo**](https://magic-spells.github.io/reveal/demo/)

## Features

- 🪶 **Tiny** - 5.3 kB gzipped all in, nothing to install alongside it
- 🎯 **IntersectionObserver-based** - no scroll handler running your animations
- 📐 **Layout geometry** - trigger lines are measured on the untransformed box, so a reveal can never move its own trigger
- 🎨 **Thirty-two effects** - fades, diagonals, slides, flips, zooms, and blurred blooms; add your own with a CSS rule
- 🎛️ **Custom-property timing** - every timing class sets one CSS variable read by a single transition rule
- 🌬️ **Tailwind entry** - every class as a `@utility`, so a project ships only the effects and timings it writes
- ⚓ **Anchor groups** - several elements can fire together off one trigger, each with its own delay
- 🎞️ **Stagger groups** - `data-reveal-group="name:50"` cascades whatever arrives together, so a loop needs no per-index class
- 🧭 **Nine anchor placements** - element edge to viewport edge, the same nine AOS supports
- ♿ **Reduced motion, live** - `prefers-reduced-motion: reduce` shows everything immediately, and the page re-arms itself if the setting changes
- 🔌 **Real teardown** - `destroy()` disconnects everything, for SPA route changes

## Installation

```bash
npm install @magic-spells/reveal
```

## Setup

**Import the CSS and initialize.** There is no pre-paint snippet and nothing to add to `<head>`:

```javascript
import Reveal from "@magic-spells/reveal";
import "@magic-spells/reveal/css";

Reveal.init({
  offset: 120,
  duration: 600,
  once: true,
});
```

Or via CDN:

```html
<link rel="stylesheet" href="https://unpkg.com/@magic-spells/reveal/dist/reveal.min.css" />
<script src="https://unpkg.com/@magic-spells/reveal"></script>
<script>
  Reveal.init();
</script>
```

### What happens when the JavaScript never runs

Resting states apply unconditionally, so an element is hidden from the first paint. The library un-hides rather than hides: `init()` adds `reveal-off` to `<html>` whenever it bails, `destroy()` adds it on the way out, and reduced motion is covered by a media query that needs no JavaScript at all.

That leaves one case the CSS cannot reach. If the stylesheet loads and the script never does - JavaScript switched off, a blocked CDN, a CSP rejection, an earlier script that threw - `.reveal` elements stay hidden. Add the override yourself if that matters for your page:

```html
<noscript>
  <style>
    .reveal { opacity: 1 !important; transform: none !important; filter: none !important; }
  </style>
</noscript>
```

`<noscript>` only covers JavaScript being *disabled*, not a bundle that fails to arrive. For that, `init()` sets `reveal-armed` on `<html>` once it has run, so a watchdog can notice:

```html
<script>
  window.addEventListener("load", function () {
    setTimeout(function () {
      var root = document.documentElement;
      if (!root.classList.contains("reveal-armed")) root.classList.add("reveal-off");
    }, 1500);
  });
</script>
```

Both are opt-in. Neither is needed for the library to work.

## Effects

| Family | Names |
|--------|-------|
| Fade | `fade`, `fade-up`, `fade-down`, `fade-left`, `fade-right` |
| Diagonal | `fade-up-right`, `fade-up-left`, `fade-down-right`, `fade-down-left` |
| Slide | `slide-up`, `slide-down`, `slide-left`, `slide-right` |
| Flip | `flip-up`, `flip-down`, `flip-left`, `flip-right` |
| Zoom in | `zoom-in`, `zoom-in-up`, `zoom-in-down`, `zoom-in-left`, `zoom-in-right` |
| Zoom out | `zoom-out`, `zoom-out-up`, `zoom-out-down`, `zoom-out-left`, `zoom-out-right` |
| Bloom | `bloom-in`, `bloom-in-up`, `bloom-in-down`, `bloom-in-left`, `bloom-in-right` |

Each is a class prefixed `reveal-`, next to the `reveal` marker: `class="reveal reveal-zoom-in-up"`. Direction is where the element *goes*, matching AOS - `fade-up` starts below and rises. `slide-*` travels a full width or height and does not fade; `bloom-*` is a zoom that starts blurred and resolves to sharp; everything else fades. A class the stylesheet doesn't know still gets a plain fade, so a typo degrades instead of breaking.

Custom properties tune them, so you rarely need a new rule:

| Property | Default | Affects |
|----------|---------|---------|
| `--reveal-distance` | `24px` | fades, diagonals, zoom and bloom offsets |
| `--reveal-slide-distance` | `100%` | slides |
| `--reveal-flip` | `45deg` | flips |
| `--reveal-perspective` | `1200px` | flips |
| `--reveal-blur` | `4px` | blooms |

## Timing classes

Timing rides on the same class vocabulary in both builds:

| Class | Sets | Plain-CSS scale |
|-------|------|-----------------|
| `reveal-delay-<ms>` | `--reveal-delay` | 0–1000, step 50 |
| `reveal-duration-<ms>` | `--reveal-duration` | 100–2000, step 100 |
| `reveal-ease-<name>` | `--reveal-easing` | `linear`, `in`, `out`, `in-out`, `spring` |

The Tailwind build has no scale - any integer generates on demand. On the plain build an off-scale value is one line of project CSS (`.reveal-delay-90 { --reveal-delay: 90ms }`), and a value computed at runtime rides the custom property directly:

```html
<div class="reveal reveal-fade-up" style="--reveal-delay: {{ forloop.index0 | times: 60 }}ms"></div>
```

For a cascade specifically, `data-reveal-group` writes that same property for you and restarts the count on every wave - see [Stagger groups](#stagger-groups).

## Tailwind

Tailwind projects import a different entry. It is **either/or** — the two builds carry the same effects, and loading both ships each one twice.

```css
@import "tailwindcss";
@import "@magic-spells/reveal/tailwind";
```

Every rule in that file is a `@utility`, so the project ships only what it writes:

```html
<div class="reveal reveal-fade-up reveal-delay-150"></div>
<div class="reveal reveal-zoom-in-up reveal-duration-800 reveal-ease-spring"></div>
```

`reveal` is the marker. It carries the transition and the resting opacity, and it is the one thing the JavaScript queries for — **an effect class on its own is never observed.** Write three effects and three effect rules are generated; the other 29 never exist.

| Utility | Sets | Bare value |
|---------|------|-----------|
| `reveal-<effect>` | the resting state | one of the [32 effects](#effects) |
| `reveal-delay-*` | `--reveal-delay` | ms |
| `reveal-duration-*` | `--reveal-duration` | ms |
| `reveal-distance-*` | `--reveal-distance` | px |
| `reveal-slide-*` | `--reveal-slide-distance` | % |
| `reveal-flip-*` | `--reveal-flip` | deg |
| `reveal-blur-*` | `--reveal-blur` | px |
| `reveal-ease-*` | `--reveal-easing` | `linear`, `in`, `out`, `in-out`, `spring` |

Arbitrary values work throughout — `reveal-delay-[0.4s]`, `reveal-ease-[steps(4)]`. Add your own named easing by declaring `--reveal-ease-<name>` in your own `@theme`.

A value computed at runtime rides the custom property as an inline style — `style="--reveal-delay: {{ index | times: 60 }}ms"` generates no CSS at all, where a class has to exist at build time.

Behavior — `data-reveal-once`, `data-reveal-anchor`, `data-reveal-offset`, `data-reveal-group` — is read by the JavaScript from attributes either way; see below. In a loop where the index is not known at build time, [`data-reveal-group`](#stagger-groups) is the one that hands out the delays for you.

## Attributes

Classes say what a reveal looks like; data attributes say how the observer treats the element. Each overrides the matching `init()` option for that element alone:

| Attribute | Value | Description |
|-----------|-------|-------------|
| `data-reveal-offset` | px or `'%'` | Trigger distance above the viewport edge, overriding the global `offset` |
| `data-reveal-once` | `"true"` / `"false"` | Reveal once, or reveal and hide again on every crossing. Overrides the global `once` |
| `data-reveal-anchor` | CSS selector | Take the trigger geometry from that element instead of this one |
| `data-reveal-anchor-placement` | placement | Which edge of the trigger has to reach which edge of the viewport |
| `data-reveal-group` | `name` or `name:step` | Stagger the members revealed together by `step` milliseconds — see [Stagger groups](#stagger-groups) |

```html
<div
  class="reveal reveal-fade-up reveal-delay-150 reveal-duration-800"
  data-reveal-offset="20%"
  data-reveal-once="false"
>
  …
</div>
```

An unusable `data-reveal-offset` - an empty string from a template variable, a typo - warns and falls back to the global offset rather than silently becoming zero.

## JavaScript API

```javascript
import Reveal, { init, refresh, refreshHard, destroy, observeCross } from "@magic-spells/reveal";
```

### `init(options)`

Arms every `.reveal` element in the document. Safe to call again - it tears down the previous run first.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `offset` | `number\|string` | `120` | Distance above the viewport edge to trigger (px, or a percentage of viewport height like `'20%'`) |
| `duration` | `number` | `600` | Transition duration in ms |
| `easing` | `string` | `cubic-bezier(0.16, 1, 0.3, 1)` | Any CSS easing string |
| `delay` | `number` | `0` | Transition delay in ms |
| `once` | `boolean` | `true` | Reveal once, or reveal and hide again on every crossing |
| `disable` | `boolean\|function` | `false` | Skip reveals entirely. A function is called at init and its return value used |
| `syncOnScroll` | `boolean` | `false` | Also re-check on a passive scroll listener - covers IntersectionObserver lag during momentum scrolling on mobile Safari |

`duration`, `delay`, and `easing` are only written to the document when you actually pass them, so you can set the defaults in your own stylesheet instead:

```css
:root {
  --reveal-duration: 0.8s;
  --reveal-easing: ease-out;
  --reveal-distance: 40px;
}
```

Under `prefers-reduced-motion: reduce`, when `disable` resolves truthy, or in a browser without IntersectionObserver, `init()` adds `reveal-off` to `<html>` and returns without observing anything. Everything shows immediately, with no animation - including elements you append later, which is the case you cannot see coming. Reduced motion is *also* handled by a media query in the stylesheet, so it applies before the bundle has loaded. Reveal keeps listening to the setting, so changing it re-arms or disarms the page without a reload.

`init()` is a no-op without a `window`, so it is safe to call during static prerendering.

### `refresh()`

Recomputes the trigger lines. Viewport-dependent lines already rebuild themselves on resize, orientation change, and layout shifts (debounced), so this is for changes your own code caused.

### `refreshHard()`

Re-queries `.reveal` elements, then refreshes. Call after adding content to the page.

### `destroy()`

Disconnects every observer and listener, and removes the inline custom properties it wrote. Revealed elements keep `is-revealed` - removing it would snap live content back to its resting state - and anything still mid-transition is marked `reveal-done` on the way out, so its own transitions are handed straight back rather than left overridden. `reveal-off` goes on `<html>`, because nothing is left running to reveal whatever had not arrived yet. Anything still below its trigger line becomes visible at that moment. `init()` does not go through this path, so re-initializing never flashes the page.

### `observeCross(elements, options)`

The crossing machinery on its own, exported for anything that is not a CSS reveal - lazy loading, impression tracking, pinning a header. It takes the same `offset`, `placement`, `once` and `syncOnScroll`, calls `onCross(element, entry)` / `onExit(element, entry)`, and returns `{ refresh, destroy }`.

```javascript
import { observeCross } from "@magic-spells/reveal";

const impressions = observeCross(".product-card", {
  placement: "center-bottom",
  once: true,
  onCross: (el) => analytics.track("impression", el.dataset.sku),
});
```

## Anchor groups

Point several elements at one trigger and they all fire on its crossing, staggered by their own delays rather than by their own positions:

```html
<section id="pricing">
  <div class="reveal reveal-fade-up" data-reveal-anchor="#pricing">Basic</div>
  <div class="reveal reveal-fade-up reveal-delay-150" data-reveal-anchor="#pricing">Pro</div>
  <div class="reveal reveal-fade-up reveal-delay-300" data-reveal-anchor="#pricing">Team</div>
</section>
```

Add `data-reveal-anchor-placement` to say where in the viewport the anchor has to be:

```html
<div
  class="reveal reveal-zoom-in"
  data-reveal-anchor="#pricing"
  data-reveal-anchor-placement="center-center"
></div>
```

## Stagger groups

A cascade is a delay per element, and in a loop nobody can write one: the index only exists at render time, and a Tailwind class built from it — `reveal-delay-{{ i * 50 }}` — is a string the JIT never sees. `data-reveal-group` moves that arithmetic to the library.

```html
{% for product in collection.products %}
  <div class="reveal reveal-fade-up" data-reveal-group="products:60">…</div>
{% endfor %}
```

Every member of `products` that reveals in the same crossing gets an inline `--reveal-delay` of `0ms`, `60ms`, `120ms`, … in document order. No class has to exist, and nothing about the group changes what a reveal looks like.

**The step is first-wins.** It comes from the first member in document order that declares one, so a loop can repeat the same value on every iteration without them fighting. A later `products:200` on the same group is ignored, and a group where nobody declares a step — `data-reveal-group="products"` — simply has no opinion about timing, leaving each member's own `reveal-delay-*` class in force.

**Delays are relative to the wave, not to the list.** The counting restarts on every crossing, so a list taller than the viewport cascades once per screenful instead of accumulating a delay nobody would sit through — and an item that arrives on its own arrives immediately. On the way back out under `data-reveal-once="false"` the delay the group wrote is removed, so hiding is never staggered; the next wave hands out fresh delays. Only a delay the group wrote, for an element still in that group, is removed — a group with no step of its own writes nothing and removes nothing, and an element that has left its group keeps whatever `--reveal-delay` it is carrying now.

`refreshHard()` restarts the counting too. Only members actually arriving are counted, so content appended to a list that has already cascaded is a new wave starting from `0ms` rather than an item eleven at `600ms`, and re-querying never rewrites a delay under a transition still in flight.

Compose it with an anchor and the whole group fires on one crossing, in order:

```html
<section id="pricing">
  <div class="reveal reveal-fade-up" data-reveal-anchor="#pricing" data-reveal-group="plans:150">Basic</div>
  <div class="reveal reveal-fade-up" data-reveal-anchor="#pricing" data-reveal-group="plans:150">Pro</div>
  <div class="reveal reveal-fade-up" data-reveal-anchor="#pricing" data-reveal-group="plans:150">Team</div>
</section>
```

Details worth knowing:

- The step is in **milliseconds**, bare — `products:60`, not `products:60ms`.
- The group writes an inline `--reveal-delay`, which **outranks a `reveal-delay-*` class** on the same element. That is the intended precedence: in a group, the group decides the delay.
- **`products:0` is a declaration, not an omission.** It says the members arrive together, and it still overrides their delay classes — which is what makes first-wins worth having: a `0` in front wins over a `200` behind it. Declaring nothing at all is `products`, with no colon.
- `:` separates the name from the step, splitting on the **last** one — so `:` is effectively reserved in a group name. It is read as a separator only when what follows it parses as a step: `cards:hero` is a group *called* `cards:hero`, the same one `cards:hero:75` gives a step to. The exception is a trailing colon, which is a step left out — `products:` is the group `products`.
- An unusable step — non-numeric, negative — is not fatal: it is simply part of the name, and the group works without a step. One that reads as a number and still cannot be a step (`products:-50`) also logs a warning, since a silently forked group name is hard to see from the outside.
- A value that leads with the colon names nothing, so it is not a group at all: `":50"` and `":abc"` alike.
- A group is counted **per wave, not per observer**. The count is keyed by the group name alone and stays open for the rest of the task, so every member arriving in that task continues the same cascade — including members sitting on different trigger lines. A group split across `data-reveal-offset`, `data-reveal-once` or `data-reveal-anchor-placement` settings can therefore hand out `0ms, 50ms, 100ms, 150ms` straight across the two sets, or start each set from `0ms`, depending only on whether the crossings land in one task or two. Keep those three the same across a group you want counted as one.

## Anchor placements

Placements are named `<element-edge>-<viewport-edge>`: the first half is the part of the trigger element being measured, the second half is the line in the viewport it has to reach.

| Placement | Fires when |
|-----------|------------|
| `top-bottom` *(default)* | The trigger's top reaches the bottom of the viewport |
| `center-bottom` | The trigger's middle reaches the bottom of the viewport |
| `bottom-bottom` | The trigger's bottom reaches the bottom of the viewport |
| `top-center` | The trigger's top reaches the middle of the viewport |
| `center-center` | The trigger's middle reaches the middle of the viewport |
| `bottom-center` | The trigger's bottom reaches the middle of the viewport |
| `top-top` | The trigger's top reaches the top of the viewport |
| `center-top` | The trigger's middle reaches the top of the viewport |
| `bottom-top` | The trigger's bottom reaches the top of the viewport |

`offset` moves the line further up from whichever viewport edge the placement names.

The nine names and their geometry come from [AOS](https://github.com/michalsnik/aos), and for a given offset every one of them fires at the same scroll position AOS would use. **One deliberate difference:** AOS ignores the global offset as soon as an element sets an anchor placement, so `data-aos-anchor-placement="center-center"` silently drops your `offset: 120`. Reveal always applies the offset, whichever placement is in play. Set `data-reveal-offset="0"` on those elements if you want AOS's behavior.

## Single-page apps

Observers survive route changes unless you tear them down. Init on mount, destroy on unmount, and hard-refresh once the new page's DOM is in place:

```javascript
// on mount
Reveal.init({ offset: 120 });

// after a client-side navigation swaps the DOM
Reveal.refreshHard();

// on unmount
Reveal.destroy();
```

`init()` calls `destroy()` for you first, so calling `init()` on every route change also works - `refreshHard()` is just cheaper.

A rebuild reconciles what it finds: a `once: false` element that was revealed and now sits below its trigger line has its classes cleared, so a route change or a `refreshHard()` never leaves a stale reveal on screen. `once: true` reveals are left exactly as they are - staying revealed is the whole point of them.

## Styling

`.is-revealed` is the fired state. Everything else is a resting state, applied unconditionally:

```css
.reveal:not(.is-revealed) {
  opacity: 0;
}

.reveal:not(.reveal-done) {
  transition:
    opacity var(--reveal-duration) var(--reveal-easing) var(--reveal-delay),
    transform var(--reveal-duration) var(--reveal-easing) var(--reveal-delay),
    filter var(--reveal-duration) var(--reveal-easing) var(--reveal-delay);
}

.reveal-fade-up:not(.is-revealed) {
  transform: translateY(var(--reveal-distance));
}
```

Resting states are written `:not(.is-revealed)` — when the class lands they stop matching, so there is nothing to override.

| Property | Default | Set by |
|----------|---------|--------|
| `--reveal-duration` | `0.6s` | `init({ duration })`, `reveal-duration-*` |
| `--reveal-delay` | `0s` | `init({ delay })`, `reveal-delay-*`, `data-reveal-group` (inline, so it wins) |
| `--reveal-easing` | `cubic-bezier(0.16, 1, 0.3, 1)` | `init({ easing })`, `reveal-ease-*` |
| `--reveal-distance` | `24px` | your stylesheet |

Custom effects are just another resting state - no JavaScript change needed:

```css
.reveal-tilt-up:not(.is-revealed) {
  transform: perspective(800px) rotateX(-30deg);
  transform-origin: bottom;
}
```

Write resting transforms as large as you like: trigger lines are measured on the element's **layout** box - `offsetHeight` and the offsetParent chain - not on the painted box, so an effect never shifts the point at which it fires, and an element parked on its own trigger line cannot flicker between the two states.

The `transition` shorthand above is scoped to `:not(.reveal-done)`, and `reveal-done` lands the moment a reveal finishes. A component's own transitions are only overridden while it is actually animating in:

```css
/* works normally once the reveal has played */
.button.reveal {
  transition: box-shadow 0.15s ease;
}
```

## Classes

| Class | On | Meaning |
|-------|-----|---------|
| `reveal-off` | `<html>` | Resting states are off. Added by `init()` when it bails, and by `destroy()` |
| `reveal-armed` | `<html>` | `init()` has run. For watchdog snippets |
| `reveal-no-transition` | `<html>` | Transitions suppressed for a frame while `init()` arms a page that has already painted |
| `is-revealed` | each element | It has crossed its trigger line |
| `reveal-done` | each element | Its reveal transition has finished. Removed again on the way out |

## Limitations

Known in 0.1, and worth reading before you file a bug.

**Reveals inside a scrolling container use painted geometry.** The layout walk measures against the document, so an element scrolled inside an `overflow: auto` ancestor reports a position that never changes. Reveal detects a scrollable ancestor and falls back to the painted box for those elements, which is transform-aware - so their own resting transform shifts their trigger line by that distance, and `data-reveal-once="false"` inside a scroller is not supported. `once: true` reveals fire when the element is genuinely on screen, which is what these cases actually want.

**Fixed-position targets reveal immediately.** An element that does not move when the page scrolls has no scroll position at which it "arrives", so it is revealed on the first evaluation rather than never. The same applies to anything else with no offsetParent chain, such as an SVG node.

**CSS `zoom` on an ancestor mixes coordinate spaces.** `offsetTop` is reported unscaled while the observer works in scaled viewport pixels, so trigger lines under a zoomed ancestor are off by the zoom factor. Transforms are handled; `zoom` is not.

**A resting transform that grows dramatically after an element is measured can fire late.** Displacement is measured once, 400px before the trigger line, and re-measured after each transition. An effect that changes its transform between those points - a media query crossing mid-scroll, an animation retargeting the element - can put the observer's boundary up to that difference off until the next settle or refresh. Effects in the same size range as the built-ins (tens of pixels) are unaffected.

**`position: sticky` targets and iOS toolbar collapse are untested.** A sticky element's layout position and painted position diverge while it is stuck, and iOS reports viewport height changes a frame or two after the visual viewport actually changes during a toolbar collapse. Both are expected to be approximately right and are not verified.

## Browser Support

- Chrome 51+, Firefox 55+, Safari 12.1+, Edge 15+
- Without IntersectionObserver, `init()` treats the page as disabled, so content renders normally

## Development

```bash
npm install
npm run dev     # dev server on port 3004 with the demo
npm run build   # ESM, UMD, minified, and CSS into dist/
npm test        # vitest
npm run lint
```

## License

MIT © Cory Schulz

---

<p align="center">
  Made by <a href="https://github.com/coryschulz">Cory Schulz</a>
</p>
