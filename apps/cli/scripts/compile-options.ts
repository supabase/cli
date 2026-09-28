/**
 * Shared compile options keep release, local, and E2E builds exercising the shipped binary
 * compilation behavior. `bytecodeDepth` is accepted by Bun 1.4.1 but is not yet in bun-types.
 */
export const compileOptions = {
  minify: true,
  bytecode: true,
  bytecodeDepth: 2,
  format: "esm" as const,
  // `oxfmt` is an optional peer of `@supabase/postgrest-typegen`, loaded only by the default
  // TypeScript formatter; `gen types` supplies its own, so the binary ships without it.
  external: ["oxfmt"],
};
