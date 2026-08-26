// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseGroup, parseOffset, parseOnce } from "../src/attributes.js";

const attr = (html, name) => {
  document.body.innerHTML = html;
  return document.body.firstElementChild.getAttribute(name);
};

describe("parseOffset", () => {
  it("keeps percentages as strings for the viewport to resolve later", () => {
    expect(parseOffset("40%", 120)).toEqual({ value: "40%", invalid: false });
  });

  it("parses pixel values as numbers", () => {
    expect(parseOffset("0", 120)).toEqual({ value: 0, invalid: false });
    expect(parseOffset("250", 120)).toEqual({ value: 250, invalid: false });
    expect(parseOffset("-60", 120)).toEqual({ value: -60, invalid: false });
  });

  it("uses the global offset when the attribute is absent", () => {
    expect(parseOffset(null, 120)).toEqual({ value: 120, invalid: false });
    expect(parseOffset(undefined, "10%")).toEqual({
      value: "10%",
      invalid: false,
    });
  });

  it("flags an attribute that is present but unusable", () => {
    expect(parseOffset("", 120)).toEqual({ value: 120, invalid: true });
    expect(parseOffset("   ", 120)).toEqual({ value: 120, invalid: true });
    expect(parseOffset("soon", 120)).toEqual({ value: 120, invalid: true });
    expect(parseOffset("%", 120)).toEqual({ value: 120, invalid: true });
  });

  it("reads straight off an element", () => {
    expect(
      parseOffset(
        attr(`<div data-reveal-offset="30%"></div>`, "data-reveal-offset"),
        120,
      ),
    ).toEqual({ value: "30%", invalid: false });
    expect(
      parseOffset(
        attr(`<div data-reveal-offset=""></div>`, "data-reveal-offset"),
        120,
      ),
    ).toEqual({ value: 120, invalid: true });
  });
});

describe("parseGroup", () => {
  it("takes a bare name as a group with no step", () => {
    expect(parseGroup("box-list-1")).toEqual({
      name: "box-list-1",
      step: null,
    });
    expect(parseGroup("  spaced  ")).toEqual({ name: "spaced", step: null });
  });

  it("reads the step in milliseconds", () => {
    expect(parseGroup("box-list-1:50")).toEqual({
      name: "box-list-1",
      step: 50,
    });
    expect(parseGroup("row: 120 ")).toEqual({ name: "row", step: 120 });
    expect(parseGroup("row:0")).toEqual({ name: "row", step: 0 });
  });

  it("is absent when there is nothing to group by", () => {
    expect(parseGroup(null)).toBe(null);
    expect(parseGroup(undefined)).toBe(null);
    expect(parseGroup("")).toBe(null);
    expect(parseGroup("   ")).toBe(null);
    // a step with no name names no group
    expect(parseGroup(":50")).toBe(null);
    expect(parseGroup(" : 50")).toBe(null);
  });

  it("keeps the group and drops an unusable step", () => {
    expect(parseGroup("row:")).toEqual({ name: "row", step: null });
    expect(parseGroup("row:abc")).toEqual({ name: "row", step: null });
    expect(parseGroup("row:-50")).toEqual({ name: "row", step: null });
    expect(parseGroup("row:NaN")).toEqual({ name: "row", step: null });
    expect(parseGroup("row:Infinity")).toEqual({ name: "row", step: null });
  });

  it("splits on the last colon, so a name may contain earlier ones", () => {
    expect(parseGroup("cards:hero:75")).toEqual({
      name: "cards:hero",
      step: 75,
    });
  });

  it("reads straight off an element", () => {
    expect(
      parseGroup(
        attr(`<div data-reveal-group="tiles:40"></div>`, "data-reveal-group"),
      ),
    ).toEqual({ name: "tiles", step: 40 });
    expect(
      parseGroup(attr(`<div data-reveal-group=""></div>`, "data-reveal-group")),
    ).toBe(null);
  });
});

describe("parseOnce", () => {
  it("falls back to the global setting when absent", () => {
    expect(parseOnce(null, true)).toBe(true);
    expect(parseOnce(null, false)).toBe(false);
  });

  it("only 'false' turns repeating on", () => {
    expect(parseOnce("false", true)).toBe(false);
    expect(parseOnce("FALSE", true)).toBe(false);
    expect(parseOnce(" false ", true)).toBe(false);
  });

  it("treats presence as true", () => {
    expect(parseOnce("true", false)).toBe(true);
    expect(parseOnce("", false)).toBe(true);
    expect(parseOnce("yes", false)).toBe(true);
  });
});
