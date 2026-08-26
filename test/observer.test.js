// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Reveal, { observeCross } from "../src/reveal.js";
import { whenSettled } from "../src/observe-cross.js";

/**
 * A stand-in for IntersectionObserver that records what it is watching and
 * lets a test deliver entries on demand. jsdom has neither the real thing nor
 * any layout, so element geometry is stubbed too.
 */
class FakeObserver {
  static instances = [];

  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.targets = new Set();
    this.disconnected = false;
    FakeObserver.instances.push(this);
  }

  observe(element) {
    this.targets.add(element);
  }

  unobserve(element) {
    this.targets.delete(element);
  }

  disconnect() {
    this.targets.clear();
    this.disconnected = true;
  }

  /** Deliver one batch, the way a real observer would */
  fire(elements, isIntersecting = true) {
    this.callback(
      elements.map((target) => ({
        target,
        isIntersecting,
        boundingClientRect: target.getBoundingClientRect(),
      })),
      this,
    );
  }

  static watching(element) {
    return FakeObserver.instances.filter(
      (instance) => !instance.disconnected && instance.targets.has(element),
    );
  }

  static live() {
    return FakeObserver.instances.filter((instance) => !instance.disconnected);
  }
}

let scrollTop = 0;

function setScroll(value) {
  scrollTop = value;
  Object.defineProperty(window, "pageYOffset", {
    configurable: true,
    value,
  });
  Object.defineProperty(window, "scrollY", { configurable: true, value });
}

/** Give an element a layout box jsdom would otherwise report as all zeros */
function place(element, { top, height = 100, width = 300, shift = 0, parent }) {
  const offsetParent = parent === undefined ? document.body : parent;

  Object.defineProperty(element, "offsetTop", {
    configurable: true,
    get: () => top,
  });
  Object.defineProperty(element, "offsetHeight", {
    configurable: true,
    get: () => height,
  });
  Object.defineProperty(element, "offsetWidth", {
    configurable: true,
    get: () => width,
  });
  Object.defineProperty(element, "offsetParent", {
    configurable: true,
    get: () => offsetParent,
  });

  element.getBoundingClientRect = () => {
    const painted = top - scrollTop + shift;
    return {
      top: painted,
      bottom: painted + height,
      height,
      left: 0,
      right: width,
      width,
      x: 0,
      y: painted,
    };
  };
}

const revealed = (element) => element.classList.contains("is-revealed");
const done = (element) => element.classList.contains("reveal-done");

describe("reveal against a stubbed IntersectionObserver", () => {
  beforeEach(() => {
    FakeObserver.instances = [];
    globalThis.IntersectionObserver = FakeObserver;
    window.innerHeight = 800;
    setScroll(0);
    // Resting states apply unconditionally now, so <html> starts bare
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
    document.body.innerHTML = "";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    Reveal.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("arms the marker class and ignores everything else", () => {
    document.body.innerHTML = `
      <div id="cls" class="reveal reveal-fade-up"></div>
      <div id="effect-only" class="reveal-fade-up"></div>
      <div id="attr" data-reveal="fade-up"></div>`;
    const cls = document.getElementById("cls");
    const effectOnly = document.getElementById("effect-only");
    const attr = document.getElementById("attr");
    [cls, effectOnly, attr].forEach((el) => place(el, { top: 200 }));

    Reveal.init({ offset: 120 });

    expect(revealed(cls)).toBe(true);
    // an effect class with no marker is invisible to the collector
    expect(revealed(effectOnly)).toBe(false);
    // the old data-attribute markup is no longer observed
    expect(revealed(attr)).toBe(false);
  });

  it("reveals what has crossed and holds back what has not", () => {
    document.body.innerHTML = `
      <div id="above" class="reveal reveal-fade-up"></div>
      <div id="below" class="reveal reveal-fade-up"></div>`;
    const above = document.getElementById("above");
    const below = document.getElementById("below");
    place(above, { top: 200 });
    place(below, { top: 5000 });

    Reveal.init({ offset: 120 });

    expect(revealed(above)).toBe(true);
    expect(revealed(below)).toBe(false);
  });

  it("marks an element done once its transition settles, and undoes that on the way out", () => {
    document.body.innerHTML = `<div id="card" class="reveal reveal-fade-up" data-reveal-once="false"></div>`;
    const card = document.getElementById("card");
    place(card, { top: 200 });

    Reveal.init({ offset: 120 });
    expect(revealed(card)).toBe(true);
    // No transition in jsdom, so the settle lands immediately
    expect(done(card)).toBe(true);

    // scroll back until the card is below its line again
    setScroll(0);
    place(card, { top: 5000 });
    FakeObserver.watching(card).forEach((observer) =>
      observer.fire([card], false),
    );

    expect(revealed(card)).toBe(false);
    expect(done(card)).toBe(false);
  });

  it("re-reveals an element whose state class was stripped from outside", () => {
    document.body.innerHTML = `<div id="card" class="reveal reveal-fade-up"></div>`;
    const card = document.getElementById("card");
    place(card, { top: 200 });

    Reveal.init({ offset: 120 });
    expect(revealed(card)).toBe(true);
    expect(done(card)).toBe(true);

    // A framework patching the class attribute - or an author replaying the
    // reveal - takes the state class off. The class is the only record there
    // is, so the next crossing puts it straight back; a private one would call
    // this a no-op and leave the card hidden with nothing able to argue.
    card.classList.remove("is-revealed", "reveal-done");
    Reveal.refreshHard();

    expect(revealed(card)).toBe(true);
    expect(done(card)).toBe(true);
  });

  it("finishes a settle that a re-init interrupts mid-transition", () => {
    document.body.innerHTML = `
      <div id="card" class="reveal reveal-fade-up"
           style="transition-property: opacity; transition-duration: 600ms"></div>`;
    const card = document.getElementById("card");
    place(card, { top: 200 });

    Reveal.init({ offset: 120 });
    expect(revealed(card)).toBe(true);
    // the transition is still running, so `reveal-done` is owed, not given
    expect(done(card)).toBe(false);

    // A re-init lands mid-transition - the reduced-motion listener's, or a
    // consumer's. Its fresh observers re-announce a crossing that is not a
    // state change, so nothing after this point will ever settle the card:
    // teardown has to pay what it owes on the way out, or the library's
    // transition shorthand overrides the card's own for the life of the page.
    Reveal.init({ offset: 120 });

    expect(done(card)).toBe(true);
  });

  it("leaves a settle already in flight running when a rebuild re-announces it", () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div id="band"></div>
      <div id="a" class="reveal reveal-fade-up" data-reveal-anchor="#band"
           style="transition-property: opacity; transition-duration: 600ms"></div>
      <div id="b" class="reveal reveal-fade-up" data-reveal-anchor="#band"
           style="transition-property: opacity; transition-duration: 600ms"></div>`;
    const band = document.getElementById("band");
    const a = document.getElementById("a");
    const b = document.getElementById("b");
    [band, a, b].forEach((element) => place(element, { top: 200 }));

    Reveal.init({ offset: 120 });
    expect([revealed(a), revealed(b)]).toEqual([true, true]);
    expect([done(a), done(b)]).toEqual([false, false]);

    vi.advanceTimersByTime(400);

    // Only `a` loses its class, so only `a` is a state change when the rebuild
    // re-announces the anchor's one crossing. `b` is two thirds of the way
    // through a transition nobody restarted.
    a.classList.remove("is-revealed", "reveal-done");
    Reveal.refreshHard();

    vi.advanceTimersByTime(300);
    const settled = done(b);
    vi.useRealTimers();

    // restarting b's settle would hold `reveal-done` back another full 600ms
    expect(settled).toBe(true);
  });

  it("waits for a boxless element to gain a layout box", () => {
    document.body.innerHTML = `
      <div id="hidden" class="reveal reveal-fade-up"></div>
      <div id="below" class="reveal reveal-fade-up"></div>`;
    const hidden = document.getElementById("hidden");
    const below = document.getElementById("below");
    // display:none reports zeros for everything
    place(hidden, { top: 0, height: 0, width: 0, parent: null });
    hidden.getBoundingClientRect = () => ({
      top: 0,
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 0,
    });
    // measurable, and far below its line: promoted, and staying that way
    place(below, { top: 5000 });

    Reveal.init({ offset: 120 });
    expect(revealed(hidden)).toBe(false);

    const watchers = FakeObserver.watching(hidden);
    expect(watchers.length).toBeGreaterThan(0);

    // Nothing has measured `hidden`, so the observer holding it is the pre-arm
    // one - and `below`, which has been promoted off it, must be watched by its
    // real observer and by nothing else. `#arm` -> `#unobserve` is the only
    // thing that takes a promoted element off the pre-arm stage.
    const prearm = watchers[0];
    const promoted = FakeObserver.watching(below);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).not.toBe(prearm);

    // it opens: now it has a box, well above the trigger line
    place(hidden, { top: 100 });
    watchers.forEach((observer) => observer.fire([hidden]));

    expect(revealed(hidden)).toBe(true);
  });

  it("keeps going through a batch when one callback throws", () => {
    document.body.innerHTML = `<i id="a"></i><i id="b"></i>`;
    const a = document.getElementById("a");
    const b = document.getElementById("b");
    place(a, { top: 100 });
    place(b, { top: 200 });

    const seen = [];
    const handle = observeCross([a, b], {
      offset: 0,
      onCross: (element) => {
        seen.push(element.id);
        if (element.id === "a") throw new Error("consumer callback exploded");
      },
    });

    // the synchronous evaluation path, the one a refresh drives
    handle.refresh();

    expect(seen).toEqual(["a", "b"]);
    expect(console.error).toHaveBeenCalled();
    handle.destroy();
  });

  it("keeps going through an observer batch when one callback throws", () => {
    document.body.innerHTML = `<i id="a"></i><i id="b"></i>`;
    const a = document.getElementById("a");
    const b = document.getElementById("b");
    place(a, { top: 5000 });
    place(b, { top: 5000 });

    const seen = [];
    const handle = observeCross([a, b], {
      offset: 0,
      onCross: (element) => {
        seen.push(element.id);
        if (element.id === "a") throw new Error("consumer callback exploded");
      },
    });

    expect(seen).toEqual([]);

    place(a, { top: 100 });
    place(b, { top: 200 });
    const observer = FakeObserver.watching(a)[0];
    observer.fire([a, b]);

    expect(seen).toEqual(["a", "b"]);
    handle.destroy();
  });

  it("keeps a batch in document order when a target has been detached", () => {
    const ids = Array.from({ length: 12 }, (_, index) => `n${index}`);
    document.body.innerHTML = ids.map((id) => `<i id="${id}"></i>`).join("");
    const elements = ids.map((id) => document.getElementById(id));
    elements.forEach((element, index) => place(element, { top: 5000 + index }));

    // removed between the intersection being computed and its delivery, so it
    // has no position to compare against anything
    const gone = document.getElementById("n10");
    gone.remove();

    const seen = [];
    const handle = observeCross(elements, {
      offset: 0,
      onCross: (element) => seen.push(element.id),
    });

    elements.forEach((element, index) => place(element, { top: 100 + index }));
    // arriving thoroughly out of order, with the orphan in the middle
    const scrambled = [...elements].reverse();
    FakeObserver.watching(elements[0])[0].fire(scrambled);

    // whatever happens to the orphan, the rest are still left to right
    expect(seen.filter((id) => id !== "n10")).toEqual(
      ids.filter((id) => id !== "n10"),
    );
    handle.destroy();
  });

  it("clears a reveal a rebuild would otherwise strand", () => {
    document.body.innerHTML = `<div id="card" class="reveal reveal-fade-up" data-reveal-once="false"></div>`;
    const card = document.getElementById("card");
    place(card, { top: 200 });

    Reveal.init({ offset: 120 });
    expect(revealed(card)).toBe(true);

    // the reader scrolls back up: the card is below its line again, but no
    // observer fires because the rebuild replaces them all
    place(card, { top: 5000 });
    Reveal.refreshHard();

    expect(revealed(card)).toBe(false);
    expect(done(card)).toBe(false);
  });

  it("leaves `once` reveals alone across a rebuild", () => {
    document.body.innerHTML = `<div id="card" class="reveal reveal-fade-up"></div>`;
    const card = document.getElementById("card");
    place(card, { top: 200 });

    Reveal.init({ offset: 120 });
    expect(revealed(card)).toBe(true);

    place(card, { top: 5000 });
    Reveal.refreshHard();

    expect(revealed(card)).toBe(true);
  });

  it("survives a rebuild that re-enters itself, and still tears everything down", async () => {
    document.body.innerHTML = `
      <div id="one" class="reveal reveal-fade-up"></div>
      <div id="two" class="reveal reveal-fade-up"></div>
      <div id="three" class="reveal reveal-fade-up"></div>`;
    const one = document.getElementById("one");
    const two = document.getElementById("two");
    const three = document.getElementById("three");
    [one, two, three].forEach((element, index) =>
      place(element, { top: 100 + index * 10 }),
    );

    Reveal.init({ offset: 120 });

    // A MutationObserver or custom element reacting to `is-revealed` can land
    // straight back in refreshHard while the rebuild is still running.
    let reentered = false;
    const original = two.getAttribute.bind(two);
    two.getAttribute = (name) => {
      if (!reentered) {
        reentered = true;
        Reveal.refreshHard();
      }
      return original(name);
    };

    expect(() => Reveal.refreshHard()).not.toThrow();
    expect(reentered).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    two.getAttribute = original;
    expect(revealed(one)).toBe(true);
    expect(revealed(three)).toBe(true);

    Reveal.destroy();
    expect(FakeObserver.live()).toEqual([]);
  });

  it("leaves no live observer behind on destroy", () => {
    document.body.innerHTML = `<div id="card" class="reveal reveal-fade-up"></div>`;
    place(document.getElementById("card"), { top: 5000 });

    Reveal.init({ offset: 120 });
    expect(FakeObserver.live().length).toBeGreaterThan(0);

    Reveal.destroy();
    expect(FakeObserver.live()).toEqual([]);
  });

  it("reveals a fixed-position element immediately, since scrolling never moves it", () => {
    document.body.innerHTML = `<div id="pinned" class="reveal reveal-fade-up"></div>`;
    const pinned = document.getElementById("pinned");
    // no offsetParent chain, and painted well below the trigger line
    place(pinned, { top: 4000, parent: null });

    Reveal.init({ offset: 120 });

    expect(revealed(pinned)).toBe(true);
  });

  it("uses painted geometry inside a scrolling container", () => {
    document.body.innerHTML = `
      <div style="overflow: auto"><div id="inner" class="reveal reveal-fade-up"></div></div>`;
    const inner = document.getElementById("inner");
    // Layout says it is far down the document - the offsetParent walk cannot
    // see the scroller - while the painted box is on screen.
    place(inner, { top: 9000, shift: -8800 });

    Reveal.init({ offset: 120 });

    expect(revealed(inner)).toBe(true);
  });

  it("starts no settle on an instance its own callback just destroyed", () => {
    document.body.innerHTML = `<i id="card"></i>`;
    const card = document.getElementById("card");
    place(card, { top: 5000 });

    vi.spyOn(globalThis, "getComputedStyle").mockImplementation(() => ({
      overflow: "visible",
      overflowX: "visible",
      overflowY: "visible",
      transitionProperty: "transform",
      transitionDuration: "300ms",
      transitionDelay: "0ms",
    }));

    const added = vi.spyOn(card, "addEventListener");
    const removed = vi.spyOn(card, "removeEventListener");
    const transitionCalls = (spy) =>
      spy.mock.calls.filter(([type]) => type.startsWith("transition")).length;

    let handle;
    handle = observeCross([card], {
      offset: 0,
      // a consumer tearing down from inside onCross - control comes straight
      // back into #evaluate, which goes on to settle
      onCross: () => handle.destroy(),
    });

    place(card, { top: 100 });
    FakeObserver.watching(card)[0].fire([card]);

    // `finish` bails on a destroyed instance, so a wait started here would be
    // one nothing ever takes back off
    expect(transitionCalls(added)).toBe(0);
    expect(transitionCalls(removed)).toBe(0);
  });

  it("takes its settle listeners back off when the transition ends", () => {
    document.body.innerHTML = `<i id="card"></i>`;
    const card = document.getElementById("card");
    place(card, { top: 5000 });

    // jsdom computes no transition at all, so a settle would finish in the
    // same tick and never listen for anything
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation(() => ({
      overflow: "visible",
      overflowX: "visible",
      overflowY: "visible",
      transitionProperty: "transform",
      transitionDuration: "300ms",
      transitionDelay: "0ms",
    }));

    const added = vi.spyOn(card, "addEventListener");
    const removed = vi.spyOn(card, "removeEventListener");
    const transitionCalls = (spy) =>
      spy.mock.calls.filter(([type]) => type.startsWith("transition")).length;

    const handle = observeCross([card], { offset: 0, once: false });

    place(card, { top: 100 });
    FakeObserver.watching(card)[0].fire([card]);

    // the crossing started a transition, and the settle is waiting it out
    expect(transitionCalls(added)).toBe(2);
    expect(transitionCalls(removed)).toBe(0);

    const event = new Event("transitionend");
    Object.defineProperty(event, "propertyName", { value: "transform" });
    card.dispatchEvent(event);

    // every listener the wait put on comes back off with it: a stale one would
    // still be live during the next crossing's transition, and that one ends on
    // a different property - so it would cut the settle short and record a
    // shift measured mid-flight
    expect(handle.crossed(card)).toBe(true);
    expect(transitionCalls(removed)).toBe(2);

    card.dispatchEvent(event);
    expect(transitionCalls(removed)).toBe(2);

    handle.destroy();
  });

  it("never fires a settle that was cancelled, timer and all", () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<i id="card"></i>`;
    const card = document.getElementById("card");

    // jsdom computes no transition, so give it one worth waiting out
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation(() => ({
      transitionProperty: "transform",
      transitionDuration: "300ms",
      transitionDelay: "0ms",
    }));

    const finished = vi.fn();
    const cancel = whenSettled(card, finished);
    expect(typeof cancel).toBe("function");

    cancel();
    vi.advanceTimersByTime(5000);

    // The closure owns the timeout as well as the listeners. A cancelled settle
    // that still fires re-measures a box the next crossing has already moved,
    // and writes that shift over a live one.
    expect(finished).not.toHaveBeenCalled();
  });

  it("works out a scrolling ancestor once, not again on every wake-up", () => {
    document.body.innerHTML = `<div id="wrap"><i id="card"></i></div>`;
    const wrap = document.getElementById("wrap");
    const card = document.getElementById("card");
    // No layout box at all, so it never promotes: it stays on the pre-arm
    // observer and every wake-up runs #evaluate's opening again. That is the
    // hot path - under syncOnScroll it is once a frame, per element.
    place(card, { top: 0, height: 0, width: 0, parent: null });
    card.getBoundingClientRect = () => ({
      top: 0,
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 0,
    });

    const styles = vi.spyOn(globalThis, "getComputedStyle");
    const walks = () =>
      styles.mock.calls.filter(([node]) => node === wrap).length;

    const handle = observeCross([card], { offset: 0 });
    const prearm = FakeObserver.watching(card)[0];

    prearm.fire([card]);
    expect(walks()).toBe(1);

    // the walk costs a computed style per ancestor, and nothing about the
    // element changed between wake-ups
    prearm.fire([card]);
    prearm.fire([card]);
    expect(walks()).toBe(1);

    handle.destroy();
  });

  it("takes the scrolling-ancestor answer again on refresh", () => {
    document.body.innerHTML = `
      <div id="wrap"><div id="card" class="reveal reveal-fade-up"></div></div>`;
    const wrap = document.getElementById("wrap");
    const card = document.getElementById("card");
    // Layout says it is far down the document while the painted box is on
    // screen - the split only a scrolling ancestor produces.
    place(card, { top: 9000, shift: -8800 });

    Reveal.init({ offset: 120 });
    // no scroller yet, so layout geometry rules and the card has not arrived
    expect(revealed(card)).toBe(false);

    // A breakpoint or a class toggle makes the ancestor a scroller after init.
    // The answer is kept per wake-up, not for the life of the observers, so a
    // refresh has to take it again - otherwise a stale `false` denies every
    // wake-up from here on and the card never reveals at all.
    wrap.style.overflow = "auto";
    Reveal.refresh();

    expect(revealed(card)).toBe(true);
  });
});

const delay = (element) => element.style.getPropertyValue("--reveal-delay");

/** Let the current batch close, the way the next task would */
const nextWave = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("stagger groups", () => {
  beforeEach(() => {
    FakeObserver.instances = [];
    globalThis.IntersectionObserver = FakeObserver;
    window.innerHeight = 800;
    setScroll(0);
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
    document.body.innerHTML = "";
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    Reveal.destroy();
    vi.restoreAllMocks();
  });

  /** Three elements, all crossing at once, in one group */
  const row = (attributes, top = 200) => {
    document.body.innerHTML = ["a", "b", "c"]
      .map(
        (id) =>
          `<div id="${id}" class="reveal reveal-fade-up" ${attributes(id)}></div>`,
      )
      .join("");
    const elements = ["a", "b", "c"].map((id) => document.getElementById(id));
    elements.forEach((element) => place(element, { top }));
    return elements;
  };

  it("hands a batch 0, step, 2 x step in DOM order", () => {
    const [a, b, c] = row(() => `data-reveal-group="row:50"`);

    Reveal.init({ offset: 120 });

    expect([a, b, c].every(revealed)).toBe(true);
    expect([delay(a), delay(b), delay(c)]).toEqual(["0ms", "50ms", "100ms"]);
  });

  it("cascades a batch that arrives out of order in DOM order", () => {
    const [a, b, c] = row(() => `data-reveal-group="row:50"`, 5000);

    Reveal.init({ offset: 120 });
    expect([a, b, c].some(revealed)).toBe(false);

    [a, b, c].forEach((element) => place(element, { top: 100 }));
    FakeObserver.watching(a)[0].fire([c, a, b]);

    expect([delay(a), delay(b), delay(c)]).toEqual(["0ms", "50ms", "100ms"]);
  });

  it("restarts from zero on the next wave", async () => {
    const [a, b, c] = row(() => `data-reveal-group="row:50"`, 5000);
    place(a, { top: 200 });

    Reveal.init({ offset: 120 });
    expect(delay(a)).toBe("0ms");

    await nextWave();

    place(b, { top: 100 });
    place(c, { top: 100 });
    FakeObserver.watching(b)[0].fire([b, c]);

    expect([delay(b), delay(c)]).toEqual(["0ms", "50ms"]);
  });

  it("takes the step from the first member that declares one", () => {
    const [a, b, c] = row((id) =>
      id === "a"
        ? `data-reveal-group="row"`
        : `data-reveal-group="row:${id === "b" ? 80 : 200}"`,
    );

    Reveal.init({ offset: 120 });

    expect([delay(a), delay(b), delay(c)]).toEqual(["0ms", "80ms", "160ms"]);
  });

  it("leaves timing alone when no member declares a step", () => {
    const [a, b, c] = row(() => `data-reveal-group="row"`);

    Reveal.init({ offset: 120 });

    expect([a, b, c].every(revealed)).toBe(true);
    expect([delay(a), delay(b), delay(c)]).toEqual(["", "", ""]);
  });

  it("cascades an anchor group off one crossing", () => {
    document.body.innerHTML = `
      <div id="band"></div>
      <div id="a" class="reveal reveal-fade-up" data-reveal-anchor="#band" data-reveal-group="cards:50"></div>
      <div id="b" class="reveal reveal-fade-up" data-reveal-anchor="#band" data-reveal-group="cards:50"></div>
      <div id="c" class="reveal reveal-fade-up" data-reveal-anchor="#band" data-reveal-group="cards:50"></div>`;
    const band = document.getElementById("band");
    const elements = ["a", "b", "c"].map((id) => document.getElementById(id));
    [band, ...elements].forEach((element) => place(element, { top: 200 }));

    Reveal.init({ offset: 120 });

    expect(elements.every(revealed)).toBe(true);
    expect(elements.map(delay)).toEqual(["0ms", "50ms", "100ms"]);
  });

  it("drops the delay again on the way out, so hiding is immediate", () => {
    const [a, b] = row(
      () => `data-reveal-group="row:50" data-reveal-once="false"`,
    );

    Reveal.init({ offset: 120 });
    expect(delay(b)).toBe("50ms");

    place(a, { top: 5000 });
    place(b, { top: 5000 });
    FakeObserver.watching(b).forEach((observer) =>
      observer.fire([a, b], false),
    );

    expect(revealed(b)).toBe(false);
    expect(delay(b)).toBe("");
  });

  it("leaves a nameless group value out of the group", () => {
    const [a, b, c] = row((id) =>
      id === "a" ? `data-reveal-group=":50"` : `data-reveal-group="row:50"`,
    );

    Reveal.init({ offset: 120 });

    expect([a, b, c].every(revealed)).toBe(true);
    // the nameless one is simply not in a group
    expect(delay(a)).toBe("");
    expect([delay(b), delay(c)]).toEqual(["0ms", "50ms"]);
  });

  it("keeps staggering the rest when one member cannot be registered", () => {
    const [a, b, c] = row(() => `data-reveal-group="row:50"`);

    // Whatever the malformed element is - here reading its own attributes
    // throws - it must not take the cascade down with it
    b.getAttribute = () => {
      throw new Error("element exploded");
    };

    Reveal.init({ offset: 120 });

    expect(console.warn).toHaveBeenCalled();
    // the broken one was skipped entirely, never armed and never revealed
    expect(revealed(b)).toBe(false);
    expect(delay(b)).toBe("");
    // and the rest still cascade, counting only themselves
    expect([revealed(a), revealed(c)]).toEqual([true, true]);
    expect([delay(a), delay(c)]).toEqual(["0ms", "50ms"]);
  });

  it("takes a declared zero step as an explicit no-stagger", () => {
    const [a, b, c] = row((id) =>
      // first-wins: the zero comes first, so the 200 never applies
      id === "a" ? `data-reveal-group="row:0"` : `data-reveal-group="row:200"`,
    );

    Reveal.init({ offset: 120 });

    expect([a, b, c].every(revealed)).toBe(true);
    expect([delay(a), delay(b), delay(c)]).toEqual(["0ms", "0ms", "0ms"]);
  });

  it("keeps a wave open across a microtask, and closes it on a task", async () => {
    const [a, b, c] = row(() => `data-reveal-group="row:50"`, 5000);

    Reveal.init({ offset: 120 });
    expect([a, b, c].some(revealed)).toBe(false);

    // Two observer callbacks for one scroll position: a microtask checkpoint
    // falls between them, and they still describe the same arrival
    [a, b, c].forEach((element) => place(element, { top: 100 }));
    FakeObserver.watching(a)[0].fire([a]);
    await Promise.resolve();
    FakeObserver.watching(b)[0].fire([b]);

    expect([delay(a), delay(b)]).toEqual(["0ms", "50ms"]);

    // a task boundary is the first point at which nothing more can belong
    await nextWave();
    FakeObserver.watching(c)[0].fire([c]);

    expect(delay(c)).toBe("0ms");
  });

  it("restarts the count on a rebuild, ignoring members already revealed", () => {
    const [a, b, c] = row(() => `data-reveal-group="row:50"`);

    Reveal.init({ offset: 120 });
    expect([delay(a), delay(b), delay(c)]).toEqual(["0ms", "50ms", "100ms"]);

    // more of the same list arrives, and the rebuild re-announces the three
    // that are already on screen
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="d" class="reveal reveal-fade-up" data-reveal-group="row:50"></div>
       <div id="e" class="reveal reveal-fade-up" data-reveal-group="row:50"></div>`,
    );
    const [d, e] = ["d", "e"].map((id) => document.getElementById(id));
    [d, e].forEach((element) => place(element, { top: 200 }));

    Reveal.refreshHard();

    // the new pair is a wave of its own, not items four and five
    expect([revealed(d), revealed(e)]).toEqual([true, true]);
    expect([delay(d), delay(e)]).toEqual(["0ms", "50ms"]);
    // and the ones already revealed keep the delay they animated with
    expect([delay(a), delay(b), delay(c)]).toEqual(["0ms", "50ms", "100ms"]);
  });

  it("restarts the count across a destroy and re-init", () => {
    const [a, b, c] = row(() => `data-reveal-group="row:50"`);

    Reveal.init({ offset: 120 });
    expect([delay(a), delay(b), delay(c)]).toEqual(["0ms", "50ms", "100ms"]);

    Reveal.destroy();

    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="d" class="reveal reveal-fade-up" data-reveal-group="row:50"></div>`,
    );
    const d = document.getElementById("d");
    place(d, { top: 200 });

    Reveal.init({ offset: 120 });

    // the re-init announces a, b and c all over again - none of them may
    // consume an index and push the one genuinely new arrival down the wave
    expect(revealed(d)).toBe(true);
    expect(delay(d)).toBe("0ms");
  });

  it("leaves an author's own inline delay alone on the way out", () => {
    // a step-less group: the controller never writes a delay here, so it has
    // none of its own to remove
    document.body.innerHTML = `
      <div id="a" class="reveal reveal-fade-up" data-reveal-group="row"
           data-reveal-once="false" style="--reveal-delay: 300ms"></div>`;
    const a = document.getElementById("a");
    place(a, { top: 200 });

    Reveal.init({ offset: 120 });
    expect(revealed(a)).toBe(true);
    expect(delay(a)).toBe("300ms");

    place(a, { top: 5000 });
    FakeObserver.watching(a).forEach((observer) => observer.fire([a], false));

    expect(revealed(a)).toBe(false);
    expect(delay(a)).toBe("300ms");
  });

  it("leaves an author's own inline delay alone when a rebuild strands it", () => {
    document.body.innerHTML = `
      <div id="a" class="reveal reveal-fade-up" data-reveal-group="row"
           data-reveal-once="false" style="--reveal-delay: 300ms"></div>`;
    const a = document.getElementById("a");
    place(a, { top: 200 });

    Reveal.init({ offset: 120 });
    expect(delay(a)).toBe("300ms");

    // the same exit, reached through #reconcile instead of a callback
    place(a, { top: 5000 });
    Reveal.refreshHard();

    expect(revealed(a)).toBe(false);
    expect(delay(a)).toBe("300ms");
  });

  it("leaves an inline delay alone once the element has left its group", () => {
    document.body.innerHTML = `
      <div id="a" class="reveal reveal-fade-up" data-reveal-group="row:50"
           data-reveal-once="false"></div>`;
    const a = document.getElementById("a");
    place(a, { top: 200 });

    Reveal.init({ offset: 120 });
    expect(delay(a)).toBe("0ms");

    // A re-render takes the element out of the group and gives it a delay of
    // its own. The controller's claim on the property was the group's, and it
    // went with the group - the value here is the author's now.
    a.removeAttribute("data-reveal-group");
    a.style.setProperty("--reveal-delay", "300ms");
    Reveal.refreshHard();

    place(a, { top: 5000 });
    FakeObserver.watching(a).forEach((observer) => observer.fire([a], false));

    expect(revealed(a)).toBe(false);
    expect(delay(a)).toBe("300ms");
  });

  it("leaves an inline delay alone once the element has swapped groups", () => {
    // The same claim, given up the same way - but to another group rather than
    // to no group. Membership on its own says nothing: the record has to name
    // the group that actually wrote the value.
    document.body.innerHTML = `
      <div id="a" class="reveal reveal-fade-up" data-reveal-group="row:50"
           data-reveal-once="false"></div>`;
    const a = document.getElementById("a");
    place(a, { top: 200 });

    Reveal.init({ offset: 120 });
    expect(delay(a)).toBe("0ms");

    // a re-render moves it into a *step-less* group, which writes no delay of
    // its own, and hands it an author's value
    a.setAttribute("data-reveal-group", "other");
    a.style.setProperty("--reveal-delay", "300ms");
    Reveal.refreshHard();

    place(a, { top: 5000 });
    FakeObserver.watching(a).forEach((observer) => observer.fire([a], false));

    expect(revealed(a)).toBe(false);
    expect(delay(a)).toBe("300ms");
  });

  it("warns when a colon suffix reads like a step but cannot be one", () => {
    const [a, b, c] = row(() => `data-reveal-group="row:-50"`);

    Reveal.init({ offset: 120 });

    // the whole value is the group name, which is invisible from the outside
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("data-reveal-group"),
      a,
    );
    // and it is still a group, just one with nothing to say about timing
    expect([a, b, c].every(revealed)).toBe(true);
    expect([delay(a), delay(b), delay(c)]).toEqual(["", "", ""]);
  });

  it("says nothing about a name that merely contains a colon", () => {
    const [a, b, c] = row(() => `data-reveal-group="cards:hero"`);

    Reveal.init({ offset: 120 });

    expect(console.warn).not.toHaveBeenCalled();
    expect([a, b, c].every(revealed)).toBe(true);
  });
});

const off = () => document.documentElement.classList.contains("reveal-off");

describe("the reveal-off escape hatch", () => {
  beforeEach(() => {
    FakeObserver.instances = [];
    globalThis.IntersectionObserver = FakeObserver;
    window.innerHeight = 800;
    setScroll(0);
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
    document.body.innerHTML = `<div id="card" class="reveal reveal-fade-up"></div>`;
    place(document.getElementById("card"), { top: 5000 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    Reveal.destroy();
    document.documentElement.className = "";
    vi.restoreAllMocks();
  });

  it("leaves the page hidden when it arms successfully", () => {
    Reveal.init({ offset: 120 });
    expect(off()).toBe(false);
    expect(document.documentElement.classList.contains("reveal-armed")).toBe(
      true,
    );
  });

  it("un-hides when disable is true", () => {
    Reveal.init({ disable: true });
    expect(off()).toBe(true);
  });

  it("un-hides when disable is a function returning true", () => {
    Reveal.init({ disable: () => true });
    expect(off()).toBe(true);
  });

  it("un-hides without IntersectionObserver", () => {
    delete globalThis.IntersectionObserver;
    Reveal.init({ offset: 120 });
    expect(off()).toBe(true);
    globalThis.IntersectionObserver = FakeObserver;
  });

  it("re-arms when a later init is no longer disabled", () => {
    Reveal.init({ disable: true });
    expect(off()).toBe(true);

    Reveal.init({ offset: 120 });
    expect(off()).toBe(false);
  });

  it("un-hides on destroy, so nothing is left hidden with no observers", () => {
    Reveal.init({ offset: 120 });
    expect(off()).toBe(false);

    Reveal.destroy();
    expect(off()).toBe(true);
  });

  it("never adds the class mid-init, which would flash the page visible", () => {
    Reveal.init({ offset: 120 });

    const root = document.documentElement;
    const add = vi.spyOn(root.classList, "add");
    Reveal.init({ offset: 120 });

    const added = add.mock.calls.flat();
    expect(added).not.toContain("reveal-off");
    expect(off()).toBe(false);
    add.mockRestore();
  });
});
