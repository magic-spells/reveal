import { describe, expect, it } from "vitest";
import {
  documentTop,
  resolvePlacement,
  triggerLine,
} from "../src/observe-cross.js";

const PLACEMENTS = [
  "top-bottom",
  "center-bottom",
  "bottom-bottom",
  "top-center",
  "bottom-center",
  "center-center",
  "top-top",
  "bottom-top",
  "center-top",
];

/**
 * AOS's calculateOffset, transcribed from
 * aos/src/js/helpers/calculateOffset.js. AOS fires an element when
 * `windowHeight + scrollTop > position`.
 */
function aosPosition(
  placement,
  elementTop,
  elementHeight,
  windowHeight,
  offset,
) {
  let top = elementTop;

  switch (placement) {
    case "top-bottom":
      break;
    case "center-bottom":
      top += elementHeight / 2;
      break;
    case "bottom-bottom":
      top += elementHeight;
      break;
    case "top-center":
      top += windowHeight / 2;
      break;
    case "bottom-center":
      top += windowHeight / 2 + elementHeight;
      break;
    case "center-center":
      top += windowHeight / 2 + elementHeight / 2;
      break;
    case "top-top":
      top += windowHeight;
      break;
    case "bottom-top":
      top += elementHeight + windowHeight;
      break;
    case "center-top":
      top += elementHeight / 2 + windowHeight;
      break;
  }

  return top + offset;
}

/** The scroll position at which our own rule reports a crossing */
function crossingScroll(
  placement,
  elementTop,
  elementHeight,
  windowHeight,
  offset,
) {
  return (
    elementTop - triggerLine(placement, offset, windowHeight, elementHeight)
  );
}

describe("resolvePlacement", () => {
  it("knows all nine AOS placements", () => {
    PLACEMENTS.forEach((placement) => {
      expect(resolvePlacement(placement)).toHaveLength(2);
    });
  });

  it("returns null for an unknown placement", () => {
    expect(resolvePlacement("sideways-inwards")).toBeNull();
    expect(resolvePlacement("")).toBeNull();
    expect(resolvePlacement(undefined)).toBeNull();
  });

  it("maps edges to fractions", () => {
    expect(resolvePlacement("top-bottom")).toEqual([0, 1]);
    expect(resolvePlacement("center-center")).toEqual([0.5, 0.5]);
    expect(resolvePlacement("bottom-top")).toEqual([1, 0]);
  });
});

describe("triggerLine", () => {
  const viewports = [800, 500, 1024];
  const heights = [0, 120, 600, 1500];
  const offsets = [0, 120, -60];
  const elementTops = [0, 350, 4200];

  it("fires at the same scroll position as AOS, for every placement", () => {
    PLACEMENTS.forEach((placement) => {
      viewports.forEach((windowHeight) => {
        heights.forEach((elementHeight) => {
          offsets.forEach((offset) => {
            elementTops.forEach((elementTop) => {
              const ours = crossingScroll(
                placement,
                elementTop,
                elementHeight,
                windowHeight,
                offset,
              );
              const aos =
                aosPosition(
                  placement,
                  elementTop,
                  elementHeight,
                  windowHeight,
                  offset,
                ) - windowHeight;

              expect(ours).toBeCloseTo(aos, 10);
            });
          });
        });
      });
    });
  });

  it("moves the crossing point with the element, one pixel for one pixel", () => {
    PLACEMENTS.forEach((placement) => {
      const base = crossingScroll(placement, 1000, 300, 800, 120);
      expect(crossingScroll(placement, 1250, 300, 800, 120)).toBe(base + 250);
      expect(crossingScroll(placement, 0, 300, 800, 120)).toBe(base - 1000);
    });
  });

  it("puts each crossing at the scroll position it should, absolutely", () => {
    // element top 1000, height 300, viewport 800, offset 0
    const at = (placement) => crossingScroll(placement, 1000, 300, 800, 0);

    expect(at("top-bottom")).toBe(200);
    expect(at("center-bottom")).toBe(350);
    expect(at("bottom-bottom")).toBe(500);
    expect(at("top-center")).toBe(600);
    expect(at("center-center")).toBe(750);
    expect(at("bottom-center")).toBe(900);
    expect(at("top-top")).toBe(1000);
    expect(at("center-top")).toBe(1150);
    expect(at("bottom-top")).toBe(1300);
  });

  it("delays every crossing by the offset", () => {
    PLACEMENTS.forEach((placement) => {
      expect(crossingScroll(placement, 1000, 300, 800, 120)).toBe(
        crossingScroll(placement, 1000, 300, 800, 0) + 120,
      );
    });
  });

  it("puts top-bottom at the viewport bottom", () => {
    expect(triggerLine("top-bottom", 0, 800, 600)).toBe(800);
  });

  it("lifts the line by the offset", () => {
    expect(triggerLine("top-bottom", 120, 800, 600)).toBe(680);
  });

  it("measures the element's own edge for center and bottom", () => {
    expect(triggerLine("center-bottom", 0, 800, 600)).toBe(500);
    expect(triggerLine("bottom-bottom", 0, 800, 600)).toBe(200);
  });

  it("moves to the viewport middle and top", () => {
    expect(triggerLine("top-center", 0, 800, 600)).toBe(400);
    expect(triggerLine("top-top", 0, 800, 600)).toBe(0);
  });

  it("combines both edges", () => {
    expect(triggerLine("center-center", 0, 800, 600)).toBe(100);
    expect(triggerLine("bottom-top", 0, 800, 600)).toBe(-600);
  });

  it("falls back to top-bottom for an unknown placement", () => {
    expect(triggerLine("nonsense", 0, 800, 600)).toBe(
      triggerLine("top-bottom", 0, 800, 600),
    );
  });

  it("ignores element height for top-* placements", () => {
    expect(triggerLine("top-center", 40, 800, 0)).toBe(
      triggerLine("top-center", 40, 800, 900),
    );
  });
});

describe("documentTop", () => {
  // Plain objects stand in for the offsetParent chain: jsdom has no layout, and
  // the walk only ever touches offsetTop, scrollTop, tagName and offsetParent.
  const body = {
    tagName: "BODY",
    offsetTop: 0,
    scrollTop: 40,
    offsetParent: null,
  };

  it("accumulates offsetTop up the chain", () => {
    const section = {
      tagName: "SECTION",
      offsetTop: 300,
      scrollTop: 0,
      offsetParent: body,
    };
    const card = {
      tagName: "DIV",
      offsetTop: 60,
      scrollTop: 0,
      offsetParent: section,
    };

    expect(documentTop(card)).toBe(360);
  });

  // Only positioned scrollers appear in this chain at all; a static
  // overflow:auto ancestor is invisible to it - see geometry.test.js.
  it("subtracts the scroll of a scroller that is also an offsetParent", () => {
    const scroller = {
      tagName: "DIV",
      offsetTop: 300,
      scrollTop: 50,
      offsetParent: body,
    };
    const card = {
      tagName: "DIV",
      offsetTop: 60,
      scrollTop: 0,
      offsetParent: scroller,
    };

    expect(documentTop(card)).toBe(310);
  });

  it("never subtracts the body's own scroll", () => {
    const scrolledBody = {
      tagName: "BODY",
      offsetTop: 0,
      scrollTop: 400,
      offsetParent: null,
    };
    const card = {
      tagName: "DIV",
      offsetTop: 900,
      scrollTop: 0,
      offsetParent: scrolledBody,
    };

    expect(documentTop(card)).toBe(900);
  });

  it("stops at a node with no numeric offsetTop", () => {
    const svg = {
      tagName: "svg",
      offsetTop: undefined,
      offsetParent: undefined,
    };
    expect(documentTop(svg)).toBe(0);
  });
});
