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
 * Parse a once flag
 * @param {string|null} raw - Attribute value
 * @param {boolean} fallback - Global once setting
 * @returns {boolean} Whether the element reveals only once
 */
export function parseOnce(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  return String(raw).trim().toLowerCase() !== "false";
}
