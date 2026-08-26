// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { hasScrollableAncestor } from "../src/observe-cross.js";

const build = (html) => {
  document.body.innerHTML = html;
  return document.getElementById("target");
};

describe("hasScrollableAncestor", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("finds a static overflow ancestor - the one the offsetParent walk cannot see", () => {
    // A static (unpositioned) scroller never appears in an offsetParent chain,
    // so the layout walk reports a position that scrolling inside it never
    // changes. That is exactly the case this detection exists for.
    const target = build(
      `<div style="overflow: auto"><p id="target">inside a scroller</p></div>`,
    );
    expect(hasScrollableAncestor(target)).toBe(true);
  });

  it("finds one on either axis, and further up the tree", () => {
    expect(
      hasScrollableAncestor(
        build(`<div style="overflow-y: scroll"><p id="target"></p></div>`),
      ),
    ).toBe(true);
    expect(
      hasScrollableAncestor(
        build(`<div style="overflow-x: auto"><p id="target"></p></div>`),
      ),
    ).toBe(true);
    expect(
      hasScrollableAncestor(
        build(
          `<div style="overflow: auto"><section><p id="target"></p></section></div>`,
        ),
      ),
    ).toBe(true);
  });

  it("ignores ancestors that do not scroll their own content", () => {
    expect(hasScrollableAncestor(build(`<div><p id="target"></p></div>`))).toBe(
      false,
    );
    expect(
      hasScrollableAncestor(
        build(`<div style="overflow: hidden"><p id="target"></p></div>`),
      ),
    ).toBe(false);
    expect(
      hasScrollableAncestor(
        build(`<div style="overflow: visible"><p id="target"></p></div>`),
      ),
    ).toBe(false);
  });

  it("stops at the body - the page's own scrolling is the thing being measured", () => {
    document.body.style.overflow = "auto";
    const target = build(`<p id="target"></p>`);
    expect(hasScrollableAncestor(target)).toBe(false);
    document.body.style.overflow = "";
  });
});
