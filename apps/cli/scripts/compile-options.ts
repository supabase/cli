/**
 * Shared compile options keep release, local, and E2E builds exercising the shipped binary
 * compilation behavior. `bytecodeDepth` is accepted by Bun 1.4.1 but is not yet in bun-types.
 */
export const compileOptions = {
  minify: true,
  bytecode: true,
  bytecodeDepth: 2,
  format: "esm" as const,
};
