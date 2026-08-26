import "./reveal.css";
import { observeCross, transitionPlan } from "./observe-cross.js";
import { parseGroup, parseOffset, parseOnce } from "./attributes.js";

/**
 * Class on <html> that un-hides every resting state. Resting states apply
 * unconditionally, so this is the escape hatch rather than the gate: it goes on
 * whenever init() bails, and on the way out of destroy().
 */
const OFF_CLASS = "reveal-off";

/** Class that suppresses transitions for a frame, so re-arming never animates */
const NO_TRANSITION_CLASS = "reveal-no-transition";

/** Backstop for releasing that class where requestAnimationFrame never runs (ms) */
const NO_TRANSITION_MAX = 100;

/** Class set once init() has run, whether it armed or deliberately skipped */
const RAN_CLASS = "reveal-armed";

/** Class added to an element once it has crossed its trigger line */
const REVEALED_CLASS = "is-revealed";

/**
 * Class added once the reveal transition has finished. It releases the
 * library's `transition` shorthand, so an element's own transitions - a
 * button's box-shadow, a card's border - work again afterwards.
 */
const DONE_CLASS = "reveal-done";

// The marker class both stylesheets key on. Effect and timing classes are
// styling only; the JS never reads them.
const SELECTOR = ".reveal";
const DEFAULT_PLACEMENT = "top-bottom";
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Grace period added to a transition's own timing before giving up on it (ms) */
const SETTLE_SLACK = 80;

/** The one property a stagger group writes, as an inline style, per member */
const DELAY_PROPERTY = "--reveal-delay";

/** Global options mapped to the same properties, published on <html> */
const GLOBAL_TIMING = [
  ["duration", "--reveal-duration", true],
  ["delay", "--reveal-delay", true],
  ["easing", "--reveal-easing", false],
];

const DEFAULTS = {
  offset: 120,
  duration: 600,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
  delay: 0,
  once: true,
  disable: false,
  syncOnScroll: false,
};

/**
 * Reveal - scroll reveals driven by classes and custom properties
 *
 * One controller per page, exposed through the module's exports.
 */
class RevealController {
  // Private fields
  #options = { ...DEFAULTS };
  #userOptions = {};
  #groups = [];
  #settles = new Map();
  #groupNames = new Map();
  #groupSteps = new Map();
  // Whose inline delay the controller wrote. It outlives a rebuild - and a
  // destroy() - exactly as the value it describes does, so the controller only
  // ever removes a delay it put there itself. Whether an element is *revealed*
  // is not tracked here: that lives in the class, where anything can see it.
  #staggered = new WeakSet();
  #wave = new Map();
  #waveTimer = null;
  #initialized = false;
  #disabled = false;
  #rebuilding = false;
  #rebuildDirty = false;
  #mediaQuery = null;
  #mediaHandler = null;

  /**
   * Arm every .reveal element in the document
   * @param {Object} [options] - Configuration options
   * @param {number|string} [options.offset=120] - Distance above the viewport bottom to trigger (px or percentage like '20%')
   * @param {number} [options.duration=600] - Transition duration in ms
   * @param {string} [options.easing] - Any CSS easing string
   * @param {number} [options.delay=0] - Transition delay in ms
   * @param {boolean} [options.once=true] - Reveal once, or reveal and hide again on every crossing
   * @param {boolean|Function} [options.disable=false] - Skip reveals entirely (also skipped under prefers-reduced-motion)
   * @param {boolean} [options.syncOnScroll=false] - Re-check on a passive scroll listener, covering IntersectionObserver lag during momentum scrolling
   */
  init(options = {}) {
    // Consumers prerender under Node
    if (typeof window === "undefined") return;

    this.#teardown();

    this.#userOptions = options;
    this.#options = { ...DEFAULTS, ...options };
    this.#initialized = true;
    this.#watchReducedMotion();

    this.#disabled = this.#isDisabled();

    if (this.#disabled) {
      // Nothing will be revealing anything, so un-hide the lot. The off class
      // also covers elements added later, which is the case a consumer cannot
      // see coming.
      document.documentElement.classList.add(OFF_CLASS, RAN_CLASS);
      return;
    }

    this.#applyGlobalTiming(options);

    try {
      this.#rebuild();
      document.documentElement.classList.add(RAN_CLASS);
    } catch (error) {
      // Nothing may leave the page armed with no observers to un-arm it
      console.warn(
        "Reveal: failed to start observing, showing everything",
        error,
      );
      this.destroy();
    }
  }

  /**
   * Recompute trigger lines after a layout change
   */
  refresh() {
    if (!this.#initialized || this.#disabled) return;
    this.#groups.forEach((group) => {
      if (group.observer) group.observer.refresh();
    });
  }

  /**
   * Re-query .reveal elements, then refresh. Use after adding content.
   */
  refreshHard() {
    if (!this.#initialized || this.#disabled) return;
    this.#rebuild();
  }

  /**
   * Disconnect every observer and listener, then un-hide the page
   *
   * Revealed elements keep `is-revealed`; removing it would snap live content
   * back to its resting state. The off class goes on because nothing is left
   * running to reveal whatever had not arrived yet - including anything the
   * consumer appends afterwards.
   */
  destroy() {
    this.#teardown();
    if (typeof document !== "undefined") {
      document.documentElement.classList.add(OFF_CLASS);
    }
  }

  /**
   * Everything destroy() does except un-hiding
   *
   * init() is idempotent by tearing down first, and it must not flash the page
   * visible on its way to re-arming - so it uses this instead of destroy().
   */
  #teardown() {
    // First, because finishing the settles below writes a class, and a
    // consumer reacting to that synchronously must not be able to rebuild into
    // the teardown that is still running - refresh() and refreshHard() both
    // check this flag
    this.#initialized = false;

    this.#teardownObservers();
    this.#groups = [];

    // A settle in flight is a debt: `reveal-done` is what hands the element's
    // own transitions back, and nothing is left running to pay it afterwards.
    // Dropping it would leave the library's transition shorthand overriding
    // them for the life of the page - so teardown finishes what it started
    // rather than abandoning it.
    this.#settles.forEach((settle) => settle.finish());
    this.#settles.clear();

    // Inline delays are left where they are, the way `is-revealed` is: they
    // belong to reveals that already happened.
    this.#groupNames.clear();
    this.#groupSteps.clear();
    this.#endWave();

    if (typeof document !== "undefined") {
      GLOBAL_TIMING.forEach(([, property]) =>
        document.documentElement.style.removeProperty(property),
      );
    }

    this.#unwatchReducedMotion();
    this.#disabled = false;
    this.#rebuilding = false;
    this.#rebuildDirty = false;
  }

  /**
   * Re-query, re-group, and re-observe
   *
   * Reveal callbacks run synchronously inside #observe(), and consumer code
   * reacting to `is-revealed` - a MutationObserver, a custom element's
   * attributeChangedCallback - can land right back here. A nested call would
   * swap #groups out from under the loop still building into it, orphaning
   * every observer created after that point, so nested calls just mark the
   * pass dirty and let the outer one run again.
   *
   * A rebuild also ends the open wave. Fresh observers announce the whole page
   * from "not crossed", which is a new arrival as far as the stagger is
   * concerned - so the count has to start over, or content appended just after
   * a cascade would wait out a delay for members that are already on screen.
   */
  #rebuild() {
    if (this.#rebuilding) {
      this.#rebuildDirty = true;
      return;
    }

    this.#rebuilding = true;
    try {
      this.#endWave();
      this.#teardownObservers();
      this.#collect();
      this.#arm();
      this.#observe();
    } finally {
      this.#rebuilding = false;
    }

    if (this.#rebuildDirty) {
      this.#rebuildDirty = false;
      queueMicrotask(() => {
        if (this.#initialized && !this.#disabled) this.#rebuild();
      });
    }
  }

  /**
   * Whether reveals should be skipped entirely
   */
  #isDisabled() {
    const { disable } = this.#options;

    if (typeof disable === "function") return Boolean(disable());
    if (disable === true) return true;

    // Without IntersectionObserver there is nothing to reveal elements later,
    // so the resting states must never be armed in the first place
    if (typeof IntersectionObserver === "undefined") return true;

    return Boolean(this.#mediaQuery && this.#mediaQuery.matches);
  }

  /**
   * Re-run init when the reduced-motion setting changes under us
   */
  #watchReducedMotion() {
    if (typeof window.matchMedia !== "function") return;

    this.#mediaQuery = window.matchMedia(REDUCED_MOTION);
    this.#mediaHandler = () => this.init(this.#userOptions);

    if (typeof this.#mediaQuery.addEventListener === "function") {
      this.#mediaQuery.addEventListener("change", this.#mediaHandler);
    } else if (typeof this.#mediaQuery.addListener === "function") {
      this.#mediaQuery.addListener(this.#mediaHandler);
    }
  }

  #unwatchReducedMotion() {
    if (!this.#mediaQuery || !this.#mediaHandler) return;

    if (typeof this.#mediaQuery.removeEventListener === "function") {
      this.#mediaQuery.removeEventListener("change", this.#mediaHandler);
    } else if (typeof this.#mediaQuery.removeListener === "function") {
      this.#mediaQuery.removeListener(this.#mediaHandler);
    }

    this.#mediaQuery = null;
    this.#mediaHandler = null;
  }

  /**
   * Arm the resting states by dropping the escape hatch
   *
   * On a first init the class was never there and this is a no-op - elements
   * have been hidden since the first paint. On a re-arm (a destroy()/init()
   * pair, or reduced motion switched back off) the page is visible and every
   * element below its trigger line is about to be hidden, so transitions are
   * suppressed for a frame and the hiding is instant rather than a fade-out.
   */
  #arm() {
    const root = document.documentElement;
    if (!root.classList.contains(OFF_CLASS)) return;

    root.classList.add(NO_TRANSITION_CLASS);
    root.classList.remove(OFF_CLASS);
    // Commit the resting state under the suppression class
    void root.offsetHeight;

    // rAF does not run in a hidden tab, and re-arming there would leave
    // transitions suppressed until the tab came back. The timer is the floor.
    const release = () => root.classList.remove(NO_TRANSITION_CLASS);
    requestAnimationFrame(() => requestAnimationFrame(release));
    setTimeout(release, NO_TRANSITION_MAX);
  }

  /**
   * Publish global timing as custom properties on the document
   * Only options the caller actually passed are written, so a consumer can set
   * the defaults in their own stylesheet instead - and an option dropped on a
   * later init() stops applying.
   */
  #applyGlobalTiming(options) {
    const style = document.documentElement.style;

    GLOBAL_TIMING.forEach(([key, property, isTime]) => {
      if (!Object.prototype.hasOwnProperty.call(options, key)) {
        style.removeProperty(property);
        return;
      }
      const value = this.#options[key];
      style.setProperty(property, isTime ? `${value}ms` : value);
    });
  }

  /**
   * The element whose geometry drives the reveal - the anchor, or the element itself
   */
  #resolveTrigger(element) {
    const selector = element.getAttribute("data-reveal-anchor");
    if (!selector) return element;

    let anchor = null;
    try {
      anchor = document.querySelector(selector);
    } catch {
      // An invalid selector must not take the page down with it
      console.warn(`Reveal: invalid anchor selector "${selector}"`);
      return element;
    }

    if (!anchor) {
      console.warn(`Reveal: no element matches anchor "${selector}"`);
      return element;
    }

    return anchor;
  }

  /**
   * Build the observer groups
   *
   * Elements are grouped by the settings that decide where their trigger line
   * sits, then by trigger element - so several elements sharing one anchor all
   * reveal on the same crossing, each staggered by its own delay.
   */
  #collect() {
    const index = new Map();
    this.#groups = [];

    // Both are rebuilt from scratch: collection order decides which member's
    // step a group takes, and a rebuild can reorder or replace the members.
    this.#groupNames.clear();
    this.#groupSteps.clear();

    document.querySelectorAll(SELECTOR).forEach((element) => {
      // One malformed element must never stop the rest from being armed
      try {
        this.#register(index, element);
      } catch (error) {
        console.warn("Reveal: skipped an element", element, error);
      }
    });
  }

  #register(index, element) {
    const offset = this.#readOffset(element);
    const once = parseOnce(
      element.getAttribute("data-reveal-once"),
      this.#options.once,
    );
    const placement =
      element.getAttribute("data-reveal-anchor-placement") || DEFAULT_PLACEMENT;
    const key = `${offset}|${once}|${placement}`;

    let group = index.get(key);
    if (!group) {
      group = { offset, once, placement, byTrigger: new Map(), observer: null };
      index.set(key, group);
      this.#groups.push(group);
    }

    this.#registerGroup(element);

    const trigger = this.#resolveTrigger(element);
    const targets = group.byTrigger.get(trigger);
    if (targets) {
      targets.push(element);
    } else {
      group.byTrigger.set(trigger, [element]);
    }
  }

  #readOffset(element) {
    const { value, invalid } = parseOffset(
      element.getAttribute("data-reveal-offset"),
      this.#options.offset,
    );

    if (invalid) {
      console.warn(
        `Reveal: unusable data-reveal-offset "${element.getAttribute("data-reveal-offset")}", using ${this.#options.offset}`,
        element,
      );
    }

    return value;
  }

  /**
   * Note an element's stagger group, and the group's step
   *
   * The step is first-wins: whichever member comes first in collection order -
   * document order - and declares one sets it, and later declarations are
   * ignored rather than fought over. This runs on every rebuild, because the
   * order the members appear in is exactly what can change.
   */
  #registerGroup(element) {
    const raw = element.getAttribute("data-reveal-group");
    const group = parseGroup(raw);
    if (!group) return;

    this.#warnOnRejectedStep(raw, group, element);
    this.#groupNames.set(element, group.name);

    if (group.step !== null && !this.#groupSteps.has(group.name)) {
      this.#groupSteps.set(group.name, group.step);
    }
  }

  /**
   * Say so when a step was meant and not read
   *
   * A tail the parser will not take as a step stays part of the name, which is
   * the right answer for `cards:hero` and a silent fork of the group for
   * `cards:-50`. Nothing about the result shows the difference, so a tail that
   * reads as a number and still failed is worth a word - the same courtesy
   * `#readOffset` extends to an unusable offset.
   */
  #warnOnRejectedStep(raw, group, element) {
    if (group.step !== null || group.name !== String(raw).trim()) return;

    const split = group.name.lastIndexOf(":");
    // No colon is no attempt at a step - `data-reveal-group="50"` is a group
    // whose name happens to be a number
    if (split === -1) return;

    const tail = group.name.slice(split + 1);
    if (tail === "" || Number.isNaN(Number.parseFloat(tail))) return;

    console.warn(
      `Reveal: unusable step in data-reveal-group "${raw}", grouping by the whole value`,
      element,
    );
  }

  /**
   * Stagger the grouped elements in this batch, before they are revealed
   *
   * Only elements actually arriving are passed in. Delays are batch-relative,
   * not index-relative: the members revealed together get 0, step, 2*step, and
   * the next wave starts from zero again. A list taller than the viewport
   * therefore cascades once per wave instead of accumulating a delay nobody
   * would sit through, and an element that arrives on its own arrives
   * immediately.
   *
   * The value is written as an inline `--reveal-delay`, which is the documented
   * escape hatch for a computed timing value - it feeds the same custom
   * property the timing classes set, and outranks them.
   */
  #stagger(targets) {
    targets.forEach((element) => {
      const name = this.#groupNames.get(element);
      if (name === undefined) return;

      const step = this.#groupSteps.get(name);
      // A group with no step declared anywhere is still a group, it just has
      // nothing to say about timing - so the element's own classes stand. A
      // declared `0` is not that: it says the members arrive together, and it
      // still overrides their classes.
      if (step === undefined) return;

      let members = this.#wave.get(name);
      if (!members) {
        members = [];
        this.#wave.set(name, members);
      }

      let index = members.indexOf(element);
      if (index === -1) {
        index = members.length;
        members.push(element);
      }

      element.style.setProperty(DELAY_PROPERTY, `${index * step}ms`);
      this.#staggered.add(element);
      this.#openWave();
    });
  }

  /**
   * Keep the current batch open until the browser is done delivering it
   *
   * Every observer in a group can hand us its own callback for one scroll
   * position, and each of those callbacks is a separate turn of the event loop
   * with its own microtask checkpoint - so a microtask would close the wave
   * halfway through the arrival it is meant to describe. A task boundary is the
   * first point at which nothing more can belong to the same crossing.
   */
  #openWave() {
    if (this.#waveTimer !== null) return;
    this.#waveTimer = setTimeout(() => {
      this.#waveTimer = null;
      this.#wave.clear();
    }, 0);
  }

  #endWave() {
    if (this.#waveTimer !== null) clearTimeout(this.#waveTimer);
    this.#waveTimer = null;
    this.#wave.clear();
  }

  #observe() {
    this.#groups.forEach((group) => {
      group.observer = observeCross(Array.from(group.byTrigger.keys()), {
        offset: group.offset,
        placement: group.placement,
        once: group.once,
        syncOnScroll: this.#options.syncOnScroll,
        onCross: (trigger) => this.#setRevealed(group, trigger, true),
        onExit: (trigger) => this.#setRevealed(group, trigger, false),
      });

      // Settle the current state in this tick rather than a frame from now,
      // so a late init() never animates on-screen content
      group.observer.refresh();

      this.#reconcile(group);
    });
  }

  /**
   * Clear reveals a rebuild would otherwise strand
   *
   * Every new observer starts at "not crossed", so an element that was
   * revealed and now sits below its line agrees with the fresh evaluation and
   * gets no exit callback - while teardown deliberately left its class in
   * place. Only repeat mode can be stranded; `once` targets are meant to stay.
   */
  #reconcile(group) {
    if (group.once) return;

    group.byTrigger.forEach((targets, trigger) => {
      if (group.observer.crossed(trigger)) return;
      if (
        !targets.some((element) => element.classList.contains(REVEALED_CLASS))
      ) {
        return;
      }
      this.#setRevealed(group, trigger, false);
    });
  }

  /**
   * Move a trigger's targets into (or out of) the revealed state
   *
   * Only elements whose state actually changes take part. Every rebuild hands
   * its observers back at "not crossed" and then announces the crossings again,
   * so an already-revealed element is re-announced routinely - and acting on
   * that would restart its settle, rewrite `--reveal-delay` under a transition
   * already in flight, and let it claim a place in a wave it is not part of.
   *
   * The class itself is the record, never a private set. Anything can take
   * `is-revealed` off an element - a framework re-rendering the class
   * attribute, an author replaying a reveal - and a controller holding its own
   * opinion would call every later crossing a no-op and strand the element
   * hidden, with nothing able to argue it back.
   */
  #setRevealed(group, trigger, revealed) {
    const targets = group.byTrigger.get(trigger);
    if (!targets) return;

    const changed = targets.filter(
      (element) => element.classList.contains(REVEALED_CLASS) !== revealed,
    );
    if (changed.length === 0) return;

    // Before the class, and in the same synchronous pass, or the transition
    // starts against the delay the element was already carrying
    if (revealed) this.#stagger(changed);

    changed.forEach((element) => {
      element.classList.toggle(REVEALED_CLASS, revealed);
      if (revealed) return;

      // The reveal transition has to be in force again on the way out
      element.classList.remove(DONE_CLASS);
      // Hiding is not staggered - the next wave hands out its own delays. Only
      // a value this controller wrote, for a group the element is still in, is
      // dropped: a step-less group leaves the author's own inline
      // `--reveal-delay` alone, and so does an element that has since left its
      // group and been given a delay of its own.
      if (this.#groupNames.has(element) && this.#staggered.delete(element)) {
        element.style.removeProperty(DELAY_PROPERTY);
      }
    });

    this.#settleTargets(changed, revealed);
  }

  /**
   * Add (or withhold) `reveal-done` once each target's own transition ends
   *
   * Timed per target rather than per trigger: an anchor says nothing about the
   * duration or delay of the elements anchored to it, and cutting a 1.8s
   * reveal short would strand it mid-transform.
   *
   * Each pending settle carries its own `finish`, so a teardown can complete
   * what it interrupts rather than dropping it.
   */
  #settleTargets(targets, revealed) {
    targets.forEach((element) => {
      this.#cancelSettle(element, this.#settles.get(element));

      const finish = () => {
        this.#cancelSettle(element, this.#settles.get(element));
        element.classList.toggle(DONE_CLASS, revealed);
      };

      const plan = transitionPlan(element);
      if (plan.total <= 0) {
        finish();
        return;
      }

      const handler = (event) => {
        if (event.target !== element) return;
        if (plan.property !== "all" && event.propertyName !== plan.property) {
          return;
        }
        finish();
      };

      element.addEventListener("transitionend", handler);
      element.addEventListener("transitioncancel", handler);
      this.#settles.set(element, {
        handler,
        finish,
        timer: setTimeout(finish, plan.total + SETTLE_SLACK),
      });
    });
  }

  #cancelSettle(element, settle) {
    if (!settle) return;
    clearTimeout(settle.timer);
    element.removeEventListener("transitionend", settle.handler);
    element.removeEventListener("transitioncancel", settle.handler);
    this.#settles.delete(element);
  }

  #teardownObservers() {
    this.#groups.forEach((group) => {
      if (group.observer) group.observer.destroy();
      group.observer = null;
    });
  }
}

const controller = new RevealController();

/**
 * Arm every .reveal element
 * @param {Object} [options] - See RevealController#init
 */
export const init = (options) => controller.init(options);

/**
 * Recompute trigger lines after a layout change
 */
export const refresh = () => controller.refresh();

/**
 * Re-query .reveal elements, then refresh
 */
export const refreshHard = () => controller.refreshHard();

/**
 * Disconnect every observer and listener, leaving revealed elements revealed
 */
export const destroy = () => controller.destroy();

export { observeCross };

export default { init, refresh, refreshHard, destroy, observeCross };
