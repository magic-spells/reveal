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
export function parseOffset(raw, fallback) {
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
 * declares the step, in milliseconds, between members revealed together. A step
 * of `0` is a real declaration - "these arrive together" - and not the same as
 * declaring nothing.
 *
 * The step is read from the tail after the **last** colon, and only when that
 * tail actually parses as one. When it does not, the colon belongs to the name
 * and the **whole** value is the name: `cards:hero` has to land in the same
 * group as `cards:hero:75`, not in one called `cards`. A trailing colon is the
 * exception - `row:` is a step the author left out of `row`, not a name.
 *
 * Forgiving like the other parsers: an unparseable or negative step is simply
 * part of the name, and a value that leads with the colon - naming nothing in
 * front of it - is no group at all, whatever follows.
 *
 * @param {string|null} raw - Attribute value
 * @returns {{name: string, step: number|null}|null} The group, or null when
 * there is nothing usable to group by
 */
export function parseGroup(raw) {
  if (raw === null || raw === undefined) return null;

  const value = String(raw).trim();
  if (value === "") return null;

  const split = value.lastIndexOf(":");
  if (split === -1) return { name: value, step: null };

  const name = value.slice(0, split).trim();
  const rawStep = value.slice(split + 1).trim();

  // "row:" is "row" with the step left out - a template rendering an empty
  // value must not land its elements in a group of their own
  if (rawStep === "") return name === "" ? null : { name, step: null };

  // ":50" and ":abc" name nothing, so there is no group to put anything in -
  // whether the tail could have been a step or not
  if (name === "") return null;

  const step = Number.parseFloat(rawStep);
  // Not a step, so the colon is part of the name and none of it is a suffix
  if (!Number.isFinite(step) || step < 0) return { name: value, step: null };

  return { name, step };
}

/**
 * Parse a once flag
 * @param {string|null} raw - Attribute value
 * @param {boolean} fallback - Global once setting
 * @returns {boolean} Whether the element reveals only once
 */
export function parseOnce(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  return String(raw).trim().toLowerCase() !== "false";
}
