/**
 * Shared helpers for resolving element inputs and viewport-relative offsets.
 * Pure functions - no state, no DOM writes.
 */

/**
 * Normalize the many shapes an element input can take into an array
 * @param {string|Element|NodeList|HTMLCollection|Array<Element>} input - CSS selector, element, or element collection
 * @returns {Array<Element>} Resolved elements (empty when nothing matches)
 */
export function resolveElements(input) {
  if (!input) return [];
  if (typeof input === "string") {
    return Array.from(document.querySelectorAll(input));
  }
  if (input instanceof Element) return [input];
  if (Array.isArray(input)) return input;
  if (typeof input.length === "number") return Array.from(input);
  return [];
}

/**
 * Check whether an offset is expressed as a percentage of the viewport
 * @param {number|string} value - Offset value
 * @returns {boolean} True for values like '20%'
 */
export function isPercentageOffset(value) {
  return typeof value === "string" && value.includes("%");
}

/**
 * Convert an offset to pixels, resolving percentages against the viewport height
 * @param {number|string} value - Offset in pixels or as a percentage string
 * @param {number} [fallback=0] - Value returned when the offset can't be parsed
 * @returns {number} Offset in pixels
 */
export function offsetToPixels(value, fallback = 0) {
  if (isPercentageOffset(value)) {
    return Math.round((window.innerHeight * parseFloat(value)) / 100);
  }
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  const parsed = typeof value === "string" ? parseFloat(value) : NaN;
  return Number.isNaN(parsed) ? fallback : parsed;
}
