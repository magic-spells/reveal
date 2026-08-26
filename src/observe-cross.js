import {
  isPercentageOffset,
  offsetToPixels,
  resolveElements,
} from "./utils.js";

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

const DEFAULT_PLACEMENT = "top-bottom";

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
export function resolvePlacement(placement) {
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
export function triggerLine(
  placement,
  offsetPx,
  viewportHeight,
  elementHeight = 0,
) {
  const [elementEdge, viewportEdge] =
    resolvePlacement(placement) || PLACEMENTS[DEFAULT_PLACEMENT];

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
export function documentTop(element) {
  let top = 0;
  let node = element;

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
export function hasScrollableAncestor(element) {
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
 * The transition an element is about to run: how long, and which property
 * finishes last.
 *
 * @param {Element} element - Element whose computed transition to read
 * @returns {{total: number, property: string|null}} Milliseconds, and the
 * property whose transitionend means the whole thing is over
 */
export function transitionPlan(element) {
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
 * Tracks a set of elements against a single trigger line
 */
class CrossObserver {
  // Private fields
  #config = {
    offset: 0,
    placement: DEFAULT_PLACEMENT,
    once: false,
    syncOnScroll: false,
    threshold: 0,
    onCross: null,
    onExit: null,
  };
  #factors = PLACEMENTS[DEFAULT_PLACEMENT];
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

    if (!resolvePlacement(this.#config.placement)) {
      console.warn(
        `observeCross: unknown placement "${this.#config.placement}", falling back to "${DEFAULT_PLACEMENT}"`,
      );
      this.#config.placement = DEFAULT_PLACEMENT;
    }
    this.#factors = resolvePlacement(this.#config.placement);

    resolveElements(elements).forEach((element) => {
      if (!(element instanceof Element)) return;
      this.#states.set(element, {
        crossed: false,
        armed: false,
        done: false,
        painted: false,
        margin: null,
        height: 0,
        shift: 0,
        restingShift: 0,
        crossedShift: null,
        settling: false,
        settleTimer: null,
        settleHandler: null,
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

    if (this.#prearmObserver) {
      this.#prearmObserver.unobserve(element);
    }

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
    entries.forEach((entry) => {
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
    if (!state.armed) state.painted = hasScrollableAncestor(element);

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
    this.#cancelSettle(state);

    const plan = transitionPlan(element);
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

    if (plan.total <= 0) {
      finish();
      return;
    }

    state.settleHandler = (event) => {
      if (event.target !== element) return;
      if (plan.property !== "all" && event.propertyName !== plan.property)
        return;
      finish();
    };

    element.addEventListener("transitionend", state.settleHandler);
    element.addEventListener("transitioncancel", state.settleHandler);
    state.settleTimer = setTimeout(finish, plan.total + SETTLE_SLACK);
  }

  #cancelSettle(state, element) {
    if (state.settleTimer) {
      clearTimeout(state.settleTimer);
      state.settleTimer = null;
    }
    if (state.settleHandler) {
      const node = element || state.node;
      if (node) {
        node.removeEventListener("transitionend", state.settleHandler);
        node.removeEventListener("transitioncancel", state.settleHandler);
      }
      state.settleHandler = null;
    }
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

    this.#states.forEach((state, element) =>
      this.#cancelSettle(state, element),
    );

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
export function observeCross(elements, options = {}) {
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

export default observeCross;
