// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseOffset, parseOnce } from "../src/attributes.js";

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
