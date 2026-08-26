import { describe, expect, it } from "vitest";
import { observeCross } from "../src/observe-cross.js";

describe("observeCross under Node", () => {
  it("has no window to observe, and says so by doing nothing", () => {
    expect(typeof window).toBe("undefined");

    let crossings = 0;
    let exits = 0;
    const handle = observeCross(".card", {
      onCross: () => {
        crossings += 1;
      },
      onExit: () => {
        exits += 1;
      },
    });

    expect(typeof handle.refresh).toBe("function");
    expect(typeof handle.destroy).toBe("function");
    expect(handle.crossed({})).toBeUndefined();

    handle.refresh();
    handle.destroy();

    expect(crossings).toBe(0);
    expect(exits).toBe(0);
  });
});
