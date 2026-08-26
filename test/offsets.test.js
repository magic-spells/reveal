// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  isPercentageOffset,
  offsetToPixels,
  resolveElements,
} from "../src/utils.js";

describe("isPercentageOffset", () => {
  it("only treats percentage strings as percentages", () => {
    expect(isPercentageOffset("20%")).toBe(true);
    expect(isPercentageOffset("100")).toBe(false);
    expect(isPercentageOffset(20)).toBe(false);
    expect(isPercentageOffset(null)).toBe(false);
  });
});

describe("offsetToPixels", () => {
  it("passes pixel numbers straight through", () => {
    expect(offsetToPixels(0)).toBe(0);
    expect(offsetToPixels(120)).toBe(120);
  });

  it("keeps negative offsets, which push the line below the viewport edge", () => {
    expect(offsetToPixels(-80)).toBe(-80);
    expect(offsetToPixels("-80")).toBe(-80);
  });

  it("resolves percentages against the viewport height", () => {
    window.innerHeight = 800;
    expect(offsetToPixels("25%")).toBe(200);
    expect(offsetToPixels("50%")).toBe(400);

    window.innerHeight = 500;
    expect(offsetToPixels("50%")).toBe(250);
  });

  it("parses numeric strings, with or without a unit", () => {
    expect(offsetToPixels("40")).toBe(40);
    expect(offsetToPixels("40px")).toBe(40);
  });

  it("falls back when the value is unusable", () => {
    expect(offsetToPixels("banana", 120)).toBe(120);
    expect(offsetToPixels("", 120)).toBe(120);
    expect(offsetToPixels(undefined, 120)).toBe(120);
    expect(offsetToPixels(null, 120)).toBe(120);
    expect(offsetToPixels(NaN, 120)).toBe(120);
  });

  it("defaults the fallback to zero", () => {
    expect(offsetToPixels("banana")).toBe(0);
  });
});

describe("resolveElements", () => {
  it("accepts selectors, elements, and collections", () => {
    document.body.innerHTML = `<p class="a" id="one"></p><p class="a" id="two"></p><span id="three"></span>`;
    const one = document.getElementById("one");
    const two = document.getElementById("two");
    const three = document.getElementById("three");

    expect(resolveElements(".a")).toEqual([one, two]);
    expect(resolveElements(document.querySelectorAll("p"))).toEqual([one, two]);
    expect(resolveElements([one, two])).toEqual([one, two]);
    expect(resolveElements(document.getElementsByTagName("p"))).toEqual([
      one,
      two,
    ]);
    expect(resolveElements(three)).toEqual([three]);
    expect(resolveElements("span")).toEqual([three]);
  });

  it("returns an empty array for nothing usable", () => {
    expect(resolveElements(null)).toEqual([]);
    expect(resolveElements(undefined)).toEqual([]);
    expect(resolveElements(42)).toEqual([]);
    expect(resolveElements(".no-such-thing")).toEqual([]);
  });
});
