/**
 * Optional prettier plugins that `oxfmt`'s dist lazily `import()`s for non-TypeScript file
 * types. They are never installed — `gen types` only formats generated TypeScript, through the
 * statically embedded binding in `src/commands/gen/types/types.oxfmt.ts` — but `bun build`
 * still resolves every analyzable dynamic import, so each must be marked external.
 */
/**
 * Compile flags for the published CLI binary. `bytecodeDepth` is accepted by Bun 1.4
 * and is not yet on `Bun.BuildConfig` in bun-types 1.4.0, so it is spread from here.
 */
export const compiledBytecode = {
  minify: true,
  bytecode: true,
  bytecodeDepth: 2,
  format: "esm" as const,
};

export const OXFMT_OPTIONAL_PLUGIN_EXTERNALS = [
  "@prettier/plugin-hermes",
  "@prettier/plugin-oxc",
  "@prettier/plugin-pug",
  "@shopify/prettier-plugin-liquid",
  "@zackad/prettier-plugin-twig",
  "prettier-plugin-astro",
  "prettier-plugin-marko",
] as const;

/**
 * {@link OXFMT_OPTIONAL_PLUGIN_EXTERNALS} as `--external=<name>` CLI arguments, for `bun build`
 * invocations that shell out (e.g. `tools/release/local-release.ts`) rather than calling the
 * `Bun.build()` object API.
 */
export const oxfmtExternalArgs = OXFMT_OPTIONAL_PLUGIN_EXTERNALS.map(
  (name) => `--external=${name}`,
);
