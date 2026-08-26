import Reveal from "./reveal.js";

/**
 * UMD entry point.
 *
 * The named exports exist for bundlers only - the global is the same object the
 * ESM default export carries, so a script tag gets `Reveal.init(...)`.
 */
export default Reveal;
