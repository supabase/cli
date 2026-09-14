import type { CliConfigIo } from "./promise-facade.ts";

// Resolved by bundlers targeting `browser` for the `@supabase/config/io` subpath; there is no
// browser-safe file-IO implementation, so browser consumers must use the pure `@supabase/config`
// entrypoint instead.
//
// Exports the same seven names as `bun.ts`/`node.ts` so bundlers resolve named imports, and each
// export only throws once invoked — so a bundle that imports this module without calling into it
// doesn't crash at module evaluation.
async function unavailableInBrowser(): Promise<never> {
  throw new Error(
    '@supabase/config/io is not available in browser bundles; import the pure surface from "@supabase/config" instead.',
  );
}

// Typed against `CliConfigIo` so this can't structurally diverge from the real facades' shape.
const cliConfigIo: CliConfigIo = {
  loadCliConfig: unavailableInBrowser,
  findCliProjectRoot: unavailableInBrowser,
  findCliProjectPaths: unavailableInBrowser,
  loadCliConfigFile: unavailableInBrowser,
  loadCliProjectEnvironment: unavailableInBrowser,
  saveCliConfig: unavailableInBrowser,
  inferFunctionsManifest: unavailableInBrowser,
};

export const loadCliConfig = cliConfigIo.loadCliConfig;
export const findCliProjectRoot = cliConfigIo.findCliProjectRoot;
export const findCliProjectPaths = cliConfigIo.findCliProjectPaths;
export const loadCliConfigFile = cliConfigIo.loadCliConfigFile;
export const loadCliProjectEnvironment = cliConfigIo.loadCliProjectEnvironment;
export const saveCliConfig = cliConfigIo.saveCliConfig;
export const inferFunctionsManifest = cliConfigIo.inferFunctionsManifest;
export type { CliConfigIo } from "./promise-facade.ts";
// Re-exports every pure symbol from `.` so `./io` consumers don't need a second import; this
// stays platform-free since `index.ts`'s own graph is pure.
export * from "./index.ts";
