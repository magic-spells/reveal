(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
  typeof define === 'function' && define.amd ? define(factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.Reveal = factory());
})(this, (function () { 'use strict';

  /**
   * Shared helpers for resolving element inputs and viewport-relative offsets.
   * Pure functions - no state, no DOM writes.
   */

  /**
   * Normalize the many shapes an element input can take into an array
   * @param {string|Element|NodeList|HTMLCollection|Array<Element>} input - CSS selector, element, or element collection
   * @returns {Array<Element>} Resolved elements (empty when nothing matches)
   */
  function resolveElements(input) {
    if (!input) return [];
    if (typeof input === "string") {
      return Array.from(document.querySelectorAll(input));
    }
    if (input instanceof Element) return [input];
    if (Array.isArray(input)) return input;
    if (typeof input.length === "number") return Array.from(input);
    return [];
  }

  /**
   * Check whether an offset is expressed as a percentage of the viewport
   * @param {number|string} value - Offset value
   * @returns {boolean} True for values like '20%'
   */
  function isPercentageOffset(value) {
    return typeof value === "string" && value.includes("%");
  }

  /**
   * Convert an offset to pixels, resolving percentages against the viewport height
   * @param {number|string} value - Offset in pixels or as a percentage string
   * @param {number} [fallback=0] - Value returned when the offset can't be parsed
   * @returns {number} Offset in pixels
   */
  function offsetToPixels(value, fallback = 0) {
    if (isPercentageOffset(value)) {
      return Math.round((window.innerHeight * parseFloat(value)) / 100);
    }
    if (typeof value === "number" && !Number.isNaN(value)) return value;
    const parsed = typeof value === "string" ? parseFloat(value) : NaN;
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  /**
   * Anchor placements, using AOS's `<element-edge>-<viewport-edge>` naming.
   *
   * Each value is `[elementEdgeFactor, viewportEdgeFactor]`: a fraction of the
   * element's height and a fraction of the viewport height measured down from
   * the viewport's top edge.
   */
  const PLACEMENTS = {
    "top-bottom": [0, 1],
    "center-bottom": [0.5, 1],
    "bottom-bottom": [1, 1],
    "top-center": [0, 0.5],
    "bottom-center": [1, 0.5],
    "center-center": [0.5, 0.5],
    "top-top": [0, 0],
    "bottom-top": [1, 0],
    "center-top": [0.5, 0],
  };

  const DEFAULT_PLACEMENT$1 = "top-bottom";

  /**
   * Root margin added above the viewport for every observer.
   *
   * It keeps "intersecting" equivalent to "has crossed the line". Without it an
   * element scrolled past the top of the viewport stops intersecting and reports
   * an exit it never made, and a `*-top` placement shrinks the root to zero
   * height, where intersection is undefined across browsers.
   */
  const ROOT_TOP_MARGIN = 100000;

  /**
   * How far below its real trigger line an element is first measured.
   *
   * Observers see the *rendered* box, including any resting transform, while the
   * decision below is made on the *layout* box. The gap between the two is the
   * transform's vertical displacement, and the observer is aimed to cancel it -
   * which means the displacement has to be measured before the element can
   * possibly cross. This band is that head start, and has to comfortably exceed
   * any resting transform a consumer might write.
   */
  const PREARM_BAND = 400;

  /**
   * Slack between an observer's boundary and the real trigger line.
   *
   * An observer only reports the moment it flips, so a boundary sitting a
   * fraction of a pixel on the wrong side of the line reports a crossing that
   * the layout check then denies - and never reports again. Aiming each boundary
   * a couple of pixels *past* the line in the direction it is waiting for makes
   * the check agree with every wake-up it gets.
   */
  const TRIGGER_EPSILON = 2;

  /** Grace period added to a transition's own timing before giving up on it (ms) */
  const SETTLE_SLACK = 80;

  /** Delay before rebuilding observers after a viewport or layout change (ms) */
  const RESIZE_DEBOUNCE = 100;

  const SCROLLABLE = /(auto|scroll|overlay)/;

  /**
   * Look up a placement's [elementEdgeFactor, viewportEdgeFactor]
   * @param {string} placement - Placement name
   * @returns {Array<number>|null} Factors, or null when the name is unknown
   */
  function resolvePlacement(placement) {
    return PLACEMENTS[placement] || null;
  }

  /**
   * The viewport y-coordinate an element's layout top has to rise above
   *
   * Equivalent to AOS's calculateOffset: an element fires once
   * `scrollY > documentTop - triggerLine(...)`.
   *
   * @param {string} placement - Anchor placement
   * @param {number} offsetPx - Trigger offset in pixels
   * @param {number} viewportHeight - Viewport height in pixels
   * @param {number} [elementHeight=0] - Element's layout height in pixels
   * @returns {number} Viewport-relative y of the trigger line
   */
  function triggerLine(
    placement,
    offsetPx,
    viewportHeight,
    elementHeight = 0,
  ) {
    const [elementEdge, viewportEdge] =
      resolvePlacement(placement) || PLACEMENTS[DEFAULT_PLACEMENT$1];

    return viewportHeight * viewportEdge - elementHeight * elementEdge - offsetPx;
  }

  /**
   * An element's top in document coordinates, ignoring transforms
   *
   * Walks the offsetParent chain the way AOS does. `getBoundingClientRect()`
   * cannot stand in for this: it reports the *painted* box, so an element's own
   * reveal transform would move its own trigger line.
   *
   * @param {Element} element - Element to measure
   * @returns {number} Distance from the top of the document
   */
  function documentTop(element) {
    let top = 0;
    let node = element;

    // The typeof guard is load-bearing, not a paranoid null check: Firefox's
    // SVGElement has no offsetTop/offsetParent at all, so this is what ends the
    // walk on an SVG node and hands it the "no offsetParent chain" path.
    while (node && typeof node.offsetTop === "number") {
      top += node.offsetTop - (node.tagName !== "BODY" ? node.scrollTop : 0);
      node = node.offsetParent;
    }

    return top;
  }

  /**
   * Whether an element sits inside a scrolling container
   *
   * The offsetParent walk measures against the document, so an element scrolled
   * *inside* an ancestor reports a layout position that never changes while its
   * painted position does. Those elements fall back to painted geometry.
   *
   * @param {Element} element - Element to check
   * @returns {boolean} True when some ancestor scrolls its own content
   */
  function hasScrollableAncestor(element) {
    if (typeof window === "undefined" || typeof getComputedStyle !== "function") {
      return false;
    }

    const root = element.ownerDocument
      ? element.ownerDocument.documentElement
      : null;
    let node = element.parentElement;

    while (node && node !== root && node !== document.body) {
      const style = getComputedStyle(node);
      if (
        SCROLLABLE.test(style.overflowY) ||
        SCROLLABLE.test(style.overflowX) ||
        SCROLLABLE.test(style.overflow)
      ) {
        return true;
      }
      node = node.parentElement;
    }

    return false;
  }

  /**
   * Parse a CSS time list into milliseconds
   */
  function parseTimes(value) {
    return String(value || "")
      .split(",")
      .map((part) => {
        const text = part.trim();
        const number = Number.parseFloat(text);
        if (Number.isNaN(number)) return 0;
        return text.endsWith("ms") ? number : number * 1000;
      });
  }

  /**
   * Run a callback once the transition an element just started has finished
   *
   * Both halves of the library wait out the same transition for their own
   * reasons - reveal to release its `transition` shorthand, the observer to
   * re-measure a box that only means anything at rest - so the listening is
   * shared and only the completion differs.
   *
   * The returned closure owns every resource the wait allocated, which is what
   * keeps a listener from outliving its cycle and ending the *next* transition
   * early.
   *
   * @param {Element} element - Element whose transition to wait out
   * @param {Function} done - Called once, when it ends, is cancelled, or overruns
   * @returns {Function|null} Cancel the wait, or null when there was nothing to
   * wait for and `done` has already run
   */
  function whenSettled(element, done) {
    const plan = transitionPlan(element);

    if (plan.total <= 0) {
      done();
      return null;
    }

    const handler = (event) => {
      // A transition on a descendant bubbles through here, and a shorter
      // property finishing says nothing about the one that finishes last
      if (event.target !== element) return;
      if (plan.property !== "all" && event.propertyName !== plan.property) return;
      done();
    };

    element.addEventListener("transitionend", handler);
    element.addEventListener("transitioncancel", handler);
    const timer = setTimeout(done, plan.total + SETTLE_SLACK);

    return () => {
      clearTimeout(timer);
      element.removeEventListener("transitionend", handler);
      element.removeEventListener("transitioncancel", handler);
    };
  }

  /**
   * The transition an element is about to run: how long, and which property
   * finishes last.
   *
   * @param {Element} element - Element whose computed transition to read
   * @returns {{total: number, property: string|null}} Milliseconds, and the
   * property whose transitionend means the whole thing is over
   */
  function transitionPlan(element) {
    if (typeof getComputedStyle !== "function")
      return { total: 0, property: null };

    const style = getComputedStyle(element);
    const properties = String(style.transitionProperty || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    if (properties.length === 0) return { total: 0, property: null };

    const durations = parseTimes(style.transitionDuration);
    const delays = parseTimes(style.transitionDelay);

    let total = 0;
    let property = null;

    properties.forEach((name, index) => {
      const time =
        (durations[index % durations.length] || 0) +
        (delays[index % delays.length] || 0);
      if (time >= total) {
        total = time;
        property = name;
      }
    });

    return { total, property };
  }

  /**
   * Sort one batch of entries into document order
   *
   * The order entries arrive in is not specified anywhere, and evaluation itself
   * does not care - each element is measured against its own state. What does
   * care is a consumer counting the elements a batch reveals: staggering a row of
   * siblings only reads as a cascade if the callbacks come left to right.
   *
   * @param {IntersectionObserverEntry[]} entries
   * @returns {IntersectionObserverEntry[]} A sorted copy, or the batch untouched
   * when there is nothing to sort
   */
  function inDocumentOrder(entries) {
    if (!entries || entries.length < 2) return entries;

    return Array.prototype.slice.call(entries).sort((a, b) => {
      if (!a.target || !b.target || a.target === b.target) return 0;
      const relation = a.target.compareDocumentPosition(b.target);
      // A detached node has no position to compare, so it keeps its place
      if (relation & 1) return 0;
      return relation & 4 ? -1 : 1;
    });
  }

  /**
   * Tracks a set of elements against a single trigger line
   */
  class CrossObserver {
    // Private fields
    #config = {
      offset: 0,
      placement: DEFAULT_PLACEMENT$1,
      once: false,
      syncOnScroll: false,
      threshold: 0,
      onCross: null,
      onExit: null,
    };
    #factors = PLACEMENTS[DEFAULT_PLACEMENT$1];
    #states = new Map();
    #observers = new Map();
    #prearmObserver = null;
    #resizeObserver = null;
    #primed = new Set();
    #resizeHandler = null;
    #resizeTimer = null;
    #scrollHandler = null;
    #scrollFrame = null;
    #isDestroyed = false;

    constructor(elements, options) {
      this.#config = { ...this.#config, ...options };

      let factors = resolvePlacement(this.#config.placement);
      if (!factors) {
        console.warn(
          `observeCross: unknown placement "${this.#config.placement}", falling back to "${DEFAULT_PLACEMENT$1}"`,
        );
        this.#config.placement = DEFAULT_PLACEMENT$1;
        factors = resolvePlacement(DEFAULT_PLACEMENT$1);
      }
      this.#factors = factors;

      resolveElements(elements).forEach((element) => {
        if (!(element instanceof Element)) return;
        this.#states.set(element, {
          crossed: false,
          armed: false,
          done: false,
          // null until an evaluation decides; refresh() sets it back to null so
          // an ancestor that becomes scrollable later is picked up
          painted: null,
          margin: null,
          height: 0,
          shift: 0,
          restingShift: 0,
          crossedShift: null,
          settling: false,
          cancelSettle: null,
        });
      });

      this.#build();
      this.#setupResizeWatchers();

      if (this.#config.syncOnScroll) {
        this.#setupScrollListener();
      }
    }

    /**
     * The trigger line for an element of the given height
     */
    #line(height) {
      return triggerLine(
        this.#config.placement,
        offsetToPixels(this.#config.offset, 0),
        window.innerHeight,
        height,
      );
    }

    /**
     * Where to put an observer's boundary so it flips at the trigger line
     *
     * `shift` cancels the displacement between the painted and layout boxes, and
     * the epsilon leans the boundary past the line in whichever direction this
     * element is waiting.
     */
    #observerMargin(state) {
      const boundary =
        this.#line(state.height) +
        state.shift +
        (state.crossed ? TRIGGER_EPSILON : -TRIGGER_EPSILON);

      return Math.round(window.innerHeight - boundary);
    }

    #observerFor(margin) {
      let observer = this.#observers.get(margin);
      if (observer) return observer;

      observer = new IntersectionObserver(
        (entries) => this.#handleEntries(entries),
        {
          root: null,
          rootMargin: `${ROOT_TOP_MARGIN}px 0px ${-margin}px 0px`,
          threshold: this.#config.threshold,
        },
      );

      this.#observers.set(margin, observer);
      return observer;
    }

    /**
     * The first-stage observer, which fires PREARM_BAND px before any real
     * trigger line so heights and resting transforms can be measured in time
     */
    #getPrearmObserver() {
      if (this.#prearmObserver) return this.#prearmObserver;

      const margin = Math.round(window.innerHeight - this.#line(0) - PREARM_BAND);

      this.#prearmObserver = new IntersectionObserver(
        (entries) => this.#handleEntries(entries),
        {
          root: null,
          rootMargin: `${ROOT_TOP_MARGIN}px 0px ${-margin}px 0px`,
          threshold: 0,
        },
      );

      return this.#prearmObserver;
    }

    #build() {
      this.#states.forEach((state, element) => {
        if (state.done) return;
        if (state.armed) {
          this.#observerFor(state.margin).observe(element);
          return;
        }
        this.#getPrearmObserver().observe(element);
      });
    }

    /**
     * Measure an element's layout geometry
     *
     * `offsetHeight` and the offsetParent chain are transform-independent, which
     * is what keeps a reveal from moving its own trigger line - the rect is read
     * only to work out how far the transform displaces the painted box.
     *
     * @returns {{top: number, height: number, shift: number, floating: boolean}|null}
     * null when the element cannot be placed yet, which is never a crossing
     */
    #measureBox(element, state) {
      const rect = element.getBoundingClientRect();
      // Load-bearing, like the one in documentTop(): Firefox's SVGElement has no
      // offsetHeight/offsetWidth, and these fall back to the painted box for it
      const layoutHeight =
        typeof element.offsetHeight === "number" ? element.offsetHeight : null;
      const layoutWidth =
        typeof element.offsetWidth === "number" ? element.offsetWidth : null;

      const height = layoutHeight === null ? rect.height : layoutHeight;
      const width = layoutWidth === null ? rect.width : layoutWidth;

      // No layout box at all: display:none, a closed <details>, a detached node.
      // Left un-promoted, so the observer picks it up if it ever gains one.
      if (height <= 0 && width <= 0 && rect.height <= 0 && rect.width <= 0) {
        return null;
      }

      // An element-edge placement measures down from the element's own height. A
      // zero height means it has not been laid out yet - an image with no
      // intrinsic size, a font still loading - and measuring now would silently
      // turn `bottom-bottom` into `top-bottom`.
      if (height <= 0 && this.#factors[0] > 0) {
        return null;
      }

      // Nothing to compare a scroll-driven line against: a fixed-position element
      // does not move when the page scrolls, and an SVG node has no offsetParent
      // chain to walk.
      if (!element.offsetParent) {
        return { top: rect.top, height: rect.height, shift: 0, floating: true };
      }

      // Inside a scrolling container the layout position is stationary while the
      // painted one moves, so painted geometry is the only usable measure. It
      // carries the element's own transform with it - the documented trade.
      if (state && state.painted) {
        return { top: rect.top, height: rect.height, shift: 0, floating: false };
      }

      const top = documentTop(element) - window.pageYOffset;
      return { top, height, shift: rect.top - top, floating: false };
    }

    /**
     * Move an element off the first-stage observer and onto its real trigger line
     */
    #promote(element, state, box) {
      state.height = box.height;
      state.restingShift = box.shift;
      state.shift = state.crossed ? (state.crossedShift ?? box.shift) : box.shift;

      // An element-edge placement is measured from this element's own height, so
      // its own resizes have to re-aim it - a document-level observer never sees
      // a change contained inside a fixed-height parent.
      if (this.#factors[0] > 0 && this.#resizeObserver) {
        this.#resizeObserver.observe(element);
      }

      this.#arm(element, state);
    }

    /**
     * Point an element's observer at its current trigger line
     */
    #arm(element, state) {
      const margin = this.#observerMargin(state);
      if (state.armed && state.margin === margin) return;

      this.#unobserve(element, state);
      state.margin = margin;
      state.armed = true;
      this.#observerFor(margin).observe(element);
    }

    #unobserve(element, state) {
      if (state.margin !== null) {
        const observer = this.#observers.get(state.margin);
        if (observer) observer.unobserve(element);
      }
      if (this.#prearmObserver) {
        this.#prearmObserver.unobserve(element);
      }
    }

    #handleEntries(entries) {
      if (this.#isDestroyed) return;
      // One element's callback must never strand the rest of the batch
      inDocumentOrder(entries).forEach((entry) => {
        try {
          this.#evaluate(entry.target, entry);
        } catch (error) {
          console.error("observeCross: evaluation failed", entry.target, error);
        }
      });
    }

    /**
     * Decide whether an element has crossed its trigger line and fire callbacks
     *
     * Geometry is re-measured here rather than read from the entry: entry rects
     * are snapshots from when the intersection was computed, they can be frames
     * stale during momentum scrolling, and they carry the resting transform.
     */
    #evaluate(element, entry) {
      const state = this.#states.get(element);
      if (!state || state.done) return;

      // Decided before the first measurement: which geometry an element inside a
      // scrolling container gets is not a detail the measurement can discover.
      // Kept, because this runs per wake-up - the walk costs a computed style per
      // ancestor and an un-armed element can be woken every frame. refresh() and
      // a rebuild both clear it, so a layout change still gets a fresh answer.
      if (state.painted === null) {
        state.painted = hasScrollableAncestor(element);
      }

      const box = this.#measureBox(element, state);
      if (!box) return;

      if (!state.armed) this.#promote(element, state, box);

      state.height = box.height;
      // Mid-transition the painted box is somewhere between its two resting
      // positions; recording that transient as the shift would aim the reverse
      // boundary at a place the element never comes to rest.
      if (!state.crossed && !state.settling) state.restingShift = box.shift;

      const crossed = box.floating || box.top < this.#line(box.height);

      if (crossed === state.crossed) {
        // The observer woke us on the wrong side of its own boundary, so the
        // displacement it was aimed against has changed underneath it.
        if (entry && !state.settling && entry.isIntersecting !== crossed) {
          state.shift = box.shift;
          this.#arm(element, state);
        }
        return;
      }

      state.crossed = crossed;

      if (crossed) {
        // Retire before the callback: a callback that throws must not leave the
        // element armed to fire again.
        if (this.#config.once || box.floating) {
          this.#retire(element, state);
        } else {
          // Provisional until the transition settles and the real displacement
          // can be measured. Zero is the right guess for the overwhelmingly
          // common case - the element's own transform is on its way to none and
          // nothing else displaces it - and the first settle replaces it with a
          // measurement that also covers any persistent ancestor transform.
          state.shift = state.crossedShift ?? 0;
          this.#arm(element, state);
        }

        this.#fire(this.#config.onCross, element, entry);
        this.#settle(element, state);
        return;
      }

      state.shift = state.restingShift;
      this.#arm(element, state);
      this.#fire(this.#config.onExit, element, entry);
      this.#settle(element, state);
    }

    #fire(callback, element, entry) {
      if (typeof callback !== "function") return;
      callback(element, entry);
    }

    /**
     * Wait out the transition a state change just started, then re-measure
     *
     * The displacement between the painted and layout boxes is only meaningful
     * once the element has come to rest. Measuring it here rather than assuming
     * a known constant is what makes a persistent ancestor transform work: the
     * measurement contains it, and excludes the element's own finished one.
     */
    #settle(element, state) {
      // A consumer's onCross callback can destroy the instance, and control comes
      // straight back here. `finish` bails on a destroyed instance, so starting a
      // wait now would put listeners on that nothing ever takes back off.
      if (this.#isDestroyed) return;

      this.#cancelSettle(state);

      state.settling = true;

      const finish = () => {
        if (this.#isDestroyed) return;
        this.#cancelSettle(state);
        state.settling = false;

        if (!state.done) {
          const box = this.#measureBox(element, state);
          if (box) {
            state.height = box.height;
            state.shift = box.shift;
            if (state.crossed) state.crossedShift = box.shift;
            else state.restingShift = box.shift;
            this.#arm(element, state);
          }
        }

        if (state.done) this.#states.delete(element);
      };

      // null means there was no transition to wait for and `finish` already ran,
      // so there is nothing to cancel - and storing it would clobber whatever a
      // re-entrant settle put there in the meantime
      const cancel = whenSettled(element, finish);
      if (cancel) state.cancelSettle = cancel;
    }

    #cancelSettle(state) {
      const cancel = state.cancelSettle;
      if (!cancel) return;
      state.cancelSettle = null;
      cancel();
    }

    /**
     * Re-aim one element after its own box changed size
     */
    #remeasure(element) {
      const state = this.#states.get(element);
      if (!state || state.done || !state.armed || state.settling) return;

      const box = this.#measureBox(element, state);
      if (!box) return;

      state.height = box.height;
      state.shift = box.shift;
      if (state.crossed) state.crossedShift = box.shift;
      else state.restingShift = box.shift;

      this.#arm(element, state);
      this.#evaluate(element, null);
    }

    /**
     * Re-check every tracked element against the current layout
     */
    #evaluateAll() {
      this.#states.forEach((state, element) => {
        try {
          this.#evaluate(element, null);
        } catch (error) {
          console.error("observeCross: evaluation failed", element, error);
        }
      });
    }

    /**
     * Stop tracking an element that has fired under `once`
     *
     * The state outlives the callback by one settle, so a `.reveal-done` style
     * hook still gets its turn; it is deleted when that lands.
     */
    #retire(element, state) {
      this.#unobserve(element, state);
      if (this.#resizeObserver) this.#resizeObserver.unobserve(element);
      // Nothing is watching it any more, so the primed set would just hold it
      this.#primed.delete(element);
      state.done = true;
    }

    #teardownObservers() {
      this.#observers.forEach((observer) => observer.disconnect());
      this.#observers.clear();

      if (this.#prearmObserver) {
        this.#prearmObserver.disconnect();
        this.#prearmObserver = null;
      }
    }

    /**
     * Passive scroll re-check.
     *
     * IntersectionObserver can lag by several frames during momentum scrolling on
     * mobile Safari, which shows up as callbacks that fire late or not until the
     * next touch. Off by default - it costs a layout read per element per frame.
     */
    #setupScrollListener() {
      this.#scrollHandler = () => {
        if (this.#scrollFrame !== null) return;
        this.#scrollFrame = requestAnimationFrame(() => {
          this.#scrollFrame = null;
          if (this.#isDestroyed) return;
          this.#evaluateAll();
        });
      };

      window.addEventListener("scroll", this.#scrollHandler, { passive: true });
    }

    /**
     * Whether the trigger line depends on anything that can change at runtime.
     * A pixel offset with the default placement resolves to a constant line and
     * never needs a rebuild.
     */
    #needsResizeRebuild() {
      const [elementEdge, viewportEdge] = this.#factors;
      return (
        isPercentageOffset(this.#config.offset) ||
        viewportEdge !== 1 ||
        elementEdge !== 0
      );
    }

    #setupResizeWatchers() {
      if (!this.#needsResizeRebuild()) return;

      this.#resizeHandler = () => this.#scheduleRefresh();
      window.addEventListener("resize", this.#resizeHandler, { passive: true });
      window.addEventListener("orientationchange", this.#resizeHandler, {
        passive: true,
      });

      if (typeof ResizeObserver === "undefined") return;

      // The document entry catches layout changes that never resize the window -
      // images loading, fonts swapping, content expanding. Element entries catch
      // a target resizing inside a parent whose own size never changes.
      this.#resizeObserver = new ResizeObserver((entries) => {
        entries.forEach((entry) => {
          // observe() always delivers one callback immediately; ignore it.
          if (!this.#primed.has(entry.target)) {
            this.#primed.add(entry.target);
            return;
          }
          if (entry.target === document.documentElement) {
            this.#scheduleRefresh();
            return;
          }
          this.#remeasure(entry.target);
        });
      });
      this.#resizeObserver.observe(document.documentElement);
    }

    #scheduleRefresh() {
      if (this.#isDestroyed) return;
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = setTimeout(() => {
        this.#resizeTimer = null;
        this.refresh();
      }, RESIZE_DEBOUNCE);
    }

    /**
     * Whether an element has crossed its trigger line
     * @param {Element} element - A tracked element
     * @returns {boolean|undefined} undefined when the element is not tracked
     */
    crossed(element) {
      const state = this.#states.get(element);
      return state ? state.crossed : undefined;
    }

    /**
     * Rebuild every trigger line and re-check the current state
     */
    refresh() {
      if (this.#isDestroyed) return;

      this.#teardownObservers();

      this.#states.forEach((state) => {
        if (state.done) return;
        state.armed = false;
        state.margin = null;
        // Re-detected here, not per wake-up: an ancestor can become
        // `overflow:auto` after init - a breakpoint, a class toggle - and an
        // element left on stale `painted: false` has every wake-up denied.
        // refresh() is debounced or consumer-called, so the walk is affordable
        // here in a way it is not on the per-frame path.
        state.painted = null;
      });

      this.#build();
      this.#evaluateAll();
    }

    /**
     * Disconnect every observer and listener
     */
    destroy() {
      if (this.#isDestroyed) return;
      this.#isDestroyed = true;

      this.#teardownObservers();

      this.#states.forEach((state) => this.#cancelSettle(state));

      if (this.#resizeObserver) {
        this.#resizeObserver.disconnect();
        this.#resizeObserver = null;
      }
      this.#primed.clear();

      if (this.#resizeHandler) {
        window.removeEventListener("resize", this.#resizeHandler);
        window.removeEventListener("orientationchange", this.#resizeHandler);
        this.#resizeHandler = null;
      }

      if (this.#resizeTimer) {
        clearTimeout(this.#resizeTimer);
        this.#resizeTimer = null;
      }

      if (this.#scrollHandler) {
        window.removeEventListener("scroll", this.#scrollHandler);
        this.#scrollHandler = null;
      }

      if (this.#scrollFrame !== null) {
        cancelAnimationFrame(this.#scrollFrame);
        this.#scrollFrame = null;
      }

      this.#states.clear();
    }
  }

  /**
   * Fire a callback when elements cross a trigger line in the viewport
   *
   * The line sits `offset` pixels above the viewport edge named by `placement`,
   * and each element is measured against it at the edge named by `placement`
   * (see the nine AOS anchor placements).
   *
   * Crossings are decided on layout geometry - `offsetHeight` and the
   * offsetParent chain - so an element's own CSS transform never moves its own
   * trigger line. IntersectionObserver is the wake-up, aimed to allow for that
   * transform; the layout check decides.
   *
   * @example
   * const cross = observeCross('.card', {
   *   offset: '10%',
   *   placement: 'center-bottom',
   *   once: true,
   *   onCross: (el) => el.classList.add('is-visible'),
   * });
   *
   * @param {string|Element|NodeList|Array<Element>} elements - Elements to watch
   * @param {Object} [options] - Configuration options
   * @param {number|string} [options.offset=0] - Distance above the viewport edge to place the trigger line (px or percentage like '20%')
   * @param {string} [options.placement='top-bottom'] - Anchor placement, `<element-edge>-<viewport-edge>`: top/center/bottom paired with bottom/center/top
   * @param {boolean} [options.once=false] - Stop tracking an element after it crosses
   * @param {boolean} [options.syncOnScroll=false] - Re-check on a passive scroll listener, covering IntersectionObserver lag during momentum scrolling
   * @param {number} [options.threshold=0] - IntersectionObserver threshold; affects only how sensitively the observer wakes up, not where the trigger line sits
   * @param {Function} [options.onCross] - Called as (element, entry) when an element crosses the line; entry is null when the check came from a scroll or refresh
   * @param {Function} [options.onExit] - Called as (element, entry) when an element moves back below the line (never fires with `once: true`)
   * @returns {{refresh: Function, destroy: Function, crossed: Function}} Handle for recalculating, inspecting or tearing down
   */
  function observeCross(elements, options = {}) {
    // Runs under Node during static prerendering
    if (typeof window === "undefined") {
      return { refresh() {}, destroy() {}, crossed: () => undefined };
    }

    const instance = new CrossObserver(elements, options);

    return {
      refresh: () => instance.refresh(),
      destroy: () => instance.destroy(),
      crossed: (element) => instance.crossed(element),
    };
  }

  /**
   * Pure parsers for the data-reveal-* attributes.
   * No DOM access, no state - the controller reads the attributes and passes
   * the raw strings through here.
   */

  /**
   * Parse a trigger offset
   * @param {string|null} raw - Attribute value
   * @param {number|string} fallback - Global offset to fall back to
   * @returns {{value: number|string, invalid: boolean}} Resolved offset, and
   * whether the attribute was present but unusable
   */
  function parseOffset(raw, fallback) {
    if (raw === null || raw === undefined)
      return { value: fallback, invalid: false };

    const value = String(raw).trim();
    if (value === "") return { value: fallback, invalid: true };
    if (value.endsWith("%")) {
      const percent = Number.parseFloat(value);
      return Number.isNaN(percent)
        ? { value: fallback, invalid: true }
        : { value, invalid: false };
    }

    const pixels = Number.parseFloat(value);
    return Number.isNaN(pixels)
      ? { value: fallback, invalid: true }
      : { value: pixels, invalid: false };
  }

  /**
   * Parse a stagger group
   *
   * `name` on its own groups elements without staggering them; `name:step` also
   * declares the step, in milliseconds, between members revealed together. The
   * split is on the **last** colon, so `:` is reserved - a name containing one
   * keeps only the part before the last.
   *
   * Forgiving like the other parsers: an empty, unparseable, or negative step is
   * simply absent, and a value with no name at all is no group.
   *
   * @param {string|null} raw - Attribute value
   * @returns {{name: string, step: number|null}|null} The group, or null when
   * there is nothing usable to group by
   */
  function parseGroup(raw) {
    if (raw === null || raw === undefined) return null;

    const value = String(raw).trim();
    if (value === "") return null;

    const split = value.lastIndexOf(":");
    if (split === -1) return { name: value, step: null };

    const name = value.slice(0, split).trim();
    // ":50" names nothing, so there is no group to put anything in
    if (name === "") return null;

    const rawStep = value.slice(split + 1).trim();
    if (rawStep === "") return { name, step: null };

    const step = Number.parseFloat(rawStep);
    if (!Number.isFinite(step) || step < 0) return { name, step: null };

    return { name, step };
  }

  /**
   * Parse a once flag
   * @param {string|null} raw - Attribute value
   * @param {boolean} fallback - Global once setting
   * @returns {boolean} Whether the element reveals only once
   */
  function parseOnce(raw, fallback) {
    if (raw === null || raw === undefined) return fallback;
    return String(raw).trim().toLowerCase() !== "false";
  }

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
      this.#teardownObservers();
      this.#groups = [];

      this.#settles.forEach((cancel) => cancel());
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
      this.#initialized = false;
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
     */
    #rebuild() {
      if (this.#rebuilding) {
        this.#rebuildDirty = true;
        return;
      }

      this.#rebuilding = true;
      try {
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
      const group = parseGroup(element.getAttribute("data-reveal-group"));
      if (!group) return;

      this.#groupNames.set(element, group.name);

      if (group.step !== null && !this.#groupSteps.has(group.name)) {
        this.#groupSteps.set(group.name, group.step);
      }
    }

    /**
     * Stagger the grouped elements in this batch, before they are revealed
     *
     * Delays are batch-relative, not index-relative: the members revealed
     * together get 0, step, 2*step, and the next wave starts from zero again. A
     * list taller than the viewport therefore cascades once per wave instead of
     * accumulating a delay nobody would sit through, and an element that arrives
     * on its own arrives immediately.
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
        // nothing to say about timing - so the element's own classes stand.
        if (!step) return;

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

    #setRevealed(group, trigger, revealed) {
      const targets = group.byTrigger.get(trigger);
      if (!targets) return;

      // Before the class, and in the same synchronous pass, or the transition
      // starts against the delay the element was already carrying
      if (revealed) this.#stagger(targets);

      targets.forEach((element) => {
        element.classList.toggle(REVEALED_CLASS, revealed);
        if (revealed) return;

        // The reveal transition has to be in force again on the way out
        element.classList.remove(DONE_CLASS);
        // Hiding is not staggered - the next wave hands out its own delays
        if (this.#groupNames.has(element)) {
          element.style.removeProperty(DELAY_PROPERTY);
        }
      });

      this.#settleTargets(targets, revealed);
    }

    /**
     * Add (or withhold) `reveal-done` once each target's own transition ends
     *
     * Timed per target rather than per trigger: an anchor says nothing about the
     * duration or delay of the elements anchored to it, and cutting a 1.8s
     * reveal short would strand it mid-transform.
     */
    #settleTargets(targets, revealed) {
      targets.forEach((element) => {
        this.#cancelSettle(element);

        const finish = () => {
          this.#cancelSettle(element);
          element.classList.toggle(DONE_CLASS, revealed);
        };

        // null means there was no transition to wait for and finish already ran,
        // so there is nothing left to cancel
        const cancel = whenSettled(element, finish);
        if (cancel) this.#settles.set(element, cancel);
      });
    }

    #cancelSettle(element) {
      const cancel = this.#settles.get(element);
      if (!cancel) return;
      this.#settles.delete(element);
      cancel();
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
  const init = (options) => controller.init(options);

  /**
   * Recompute trigger lines after a layout change
   */
  const refresh = () => controller.refresh();

  /**
   * Re-query .reveal elements, then refresh
   */
  const refreshHard = () => controller.refreshHard();

  /**
   * Disconnect every observer and listener, leaving revealed elements revealed
   */
  const destroy = () => controller.destroy();

  var Reveal = { init, refresh, refreshHard, destroy, observeCross };

  return Reveal;

}));
//# sourceMappingURL=reveal.js.map
