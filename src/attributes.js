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
export function parseGroup(raw) {
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
export function parseOnce(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  return String(raw).trim().toLowerCase() !== "false";
}
