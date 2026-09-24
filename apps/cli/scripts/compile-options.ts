/**
 * Shared compile options keep release, local, and E2E builds exercising the shipped binary
 * compilation behavior.
 */
export const compileOptions = {
  minify: true,
  bytecode: true,
  bytecodeDepth: 2,
  format: "esm" as const,
} as const satisfies Partial<Bun.BuildConfig>;
