/**
 * Optional prettier plugins that `oxfmt`'s dist lazily `import()`s for non-TypeScript file
 * types. They are never installed — `gen types` only formats generated TypeScript, through the
 * statically embedded binding in `src/commands/gen/types/types.oxfmt.ts` — but `bun build`
 * still resolves every analyzable dynamic import, so each must be marked external.
 */
export const OXFMT_OPTIONAL_PLUGIN_EXTERNALS = [
  "@prettier/plugin-hermes",
  "@prettier/plugin-oxc",
  "@prettier/plugin-pug",
  "@shopify/prettier-plugin-liquid",
  "@zackad/prettier-plugin-twig",
  "prettier-plugin-astro",
  "prettier-plugin-marko",
] as const;
