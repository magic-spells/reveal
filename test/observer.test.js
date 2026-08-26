// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Reveal, { observeCross } from "../src/reveal.js";

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

  it("waits for a boxless element to gain a layout box", () => {
    document.body.innerHTML = `<div id="hidden" class="reveal reveal-fade-up"></div>`;
    const hidden = document.getElementById("hidden");
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

    Reveal.init({ offset: 120 });
    expect(revealed(hidden)).toBe(false);

    const watchers = FakeObserver.watching(hidden);
    expect(watchers.length).toBeGreaterThan(0);

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

  it("keeps staggering the rest when one group value is unusable", () => {
    const [a, b, c] = row((id) =>
      id === "a" ? `data-reveal-group=":50"` : `data-reveal-group="row:50"`,
    );

    Reveal.init({ offset: 120 });

    expect([a, b, c].every(revealed)).toBe(true);
    // the nameless one is simply not in a group
    expect(delay(a)).toBe("");
    expect([delay(b), delay(c)]).toEqual(["0ms", "50ms"]);
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
