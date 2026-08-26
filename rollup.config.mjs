import resolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import serve from "rollup-plugin-serve";
import copy from "rollup-plugin-copy";
import postcss from "rollup-plugin-postcss";

const dev = process.env.ROLLUP_WATCH;
const name = "reveal";

// observeCross is bundled in, never externalized - reveal ships with zero
// runtime dependencies.

// Shared CSS plugin config
const cssPlugin = postcss({
  extract: `${name}.css`,
  minimize: false,
  sourceMap: dev,
});

// Shared CSS plugin config (minimized version)
const cssMinPlugin = postcss({
  extract: `${name}.min.css`,
  minimize: true,
  sourceMap: dev,
});

// The Tailwind entry is hand-authored CSS, not something postcss should
// inline - it `@import`s reveal.css so Tailwind resolves the pair itself, and
// it carries @utility blocks only Tailwind understands. Copied verbatim.
const copyTailwindEntry = copy({
  targets: [{ src: `src/${name}.tailwind.css`, dest: "dist" }],
  hook: "writeBundle",
});

export default [
  // ESM build
  {
    input: "src/reveal.js",
    output: {
      file: `dist/${name}.esm.js`,
      format: "es",
      sourcemap: true,
    },
    plugins: [resolve(), cssPlugin, copyTailwindEntry],
  },
  // UMD build
  {
    input: "src/umd.js",
    output: {
      file: `dist/${name}.js`,
      format: "umd",
      name: "Reveal",
      sourcemap: true,
      exports: "default",
    },
    plugins: [resolve(), cssPlugin],
  },
  // Minified UMD for browsers
  {
    input: "src/umd.js",
    output: {
      file: `dist/${name}.min.js`,
      format: "umd",
      name: "Reveal",
      sourcemap: false,
      exports: "default",
    },
    plugins: [
      resolve(),
      cssMinPlugin,
      terser({
        keep_classnames: true,
        format: {
          comments: false,
        },
      }),
    ],
  },
  // Development build
  ...(dev
    ? [
        {
          input: "src/reveal.js",
          output: {
            file: `dist/${name}.esm.js`,
            format: "es",
            sourcemap: true,
          },
          plugins: [
            resolve(),
            cssMinPlugin,
            serve({
              contentBase: ["dist", "demo"],
              open: true,
              port: 3004,
            }),
            copy({
              targets: [
                {
                  src: `dist/${name}.esm.js`,
                  dest: "demo",
                },
                {
                  src: `dist/${name}.esm.js.map`,
                  dest: "demo",
                },
                {
                  src: `dist/${name}.min.css`,
                  dest: "demo",
                },
              ],
              hook: "writeBundle",
            }),
          ],
        },
      ]
    : []),
];
