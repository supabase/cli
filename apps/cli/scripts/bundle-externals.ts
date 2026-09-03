/**
 * Optional prettier plugins that `oxfmt`'s dist lazily `import()`s for
 * non-TypeScript file types (liquid, pug, astro, …). They are not installed —
 * gen types only ever formats generated TypeScript, through the statically
 * embedded binding in `src/legacy/commands/gen/types/types.oxfmt.ts` — but
 * `bun build` still tries to resolve every analyzable dynamic import, so each
 * one must be marked external for the compile to succeed. Shared by the dev
 * build (`build-binary.ts`) and the multi-target release build (`build.ts`).
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

export const oxfmtExternalArgs = OXFMT_OPTIONAL_PLUGIN_EXTERNALS.map(
  (name) => `--external=${name}`,
);
