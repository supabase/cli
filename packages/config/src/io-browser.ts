import type { CliConfigIo } from "./promise-facade.ts";

// Resolved by bundlers targeting `browser` for the `@supabase/config/io`
// subpath. There is no browser-safe file-IO implementation — browser
// consumers must use the pure `@supabase/config` entrypoint instead.
//
// This module must stay side-effect-free: it exports the same seven names as
// `bun.ts`/`node.ts` so a bundler resolves named imports successfully at
// BUILD time (a bare top-level `throw` here previously made every named
// import fail with a generic "No matching export", never reaching this
// curated message). Each export only throws once actually INVOKED, so an
// isomorphic/edge bundle that imports this module (directly, transitively,
// or as a namespace) but never calls into it — a real risk given Next's edge
// condition set includes "browser" — never crashes at module evaluation.
async function unavailableInBrowser(): Promise<never> {
  throw new Error(
    '@supabase/config/io is not available in browser bundles; import the pure surface from "@supabase/config" instead.',
  );
}

// Typed against `CliConfigIo` (mirroring how `bun.ts`/`node.ts` type
// their own facade object) so this module cannot structurally diverge from
// the real facades' export shape.
const cliConfigIo: CliConfigIo = {
  loadCliConfig: unavailableInBrowser,
  findCliProjectRootFor: unavailableInBrowser,
  findCliProjectPathsFor: unavailableInBrowser,
  loadCliConfigFile: unavailableInBrowser,
  loadCliProjectEnvironmentFor: unavailableInBrowser,
  saveCliConfig: unavailableInBrowser,
  loadFunctionsManifest: unavailableInBrowser,
};

export const loadCliConfig = cliConfigIo.loadCliConfig;
export const findCliProjectRootFor = cliConfigIo.findCliProjectRootFor;
export const findCliProjectPathsFor = cliConfigIo.findCliProjectPathsFor;
export const loadCliConfigFile = cliConfigIo.loadCliConfigFile;
export const loadCliProjectEnvironmentFor = cliConfigIo.loadCliProjectEnvironmentFor;
export const saveCliConfig = cliConfigIo.saveCliConfig;
export const loadFunctionsManifest = cliConfigIo.loadFunctionsManifest;
export type { CliConfigIo } from "./promise-facade.ts";
// Re-exports every pure symbol from `.` (types, schema, errors, etc.) so
// `./io` consumers can name `LoadedCliConfig`/`CliProjectPaths`/etc. without
// a second import from `@supabase/config` — `index.ts`'s own graph is pure,
// so this doesn't drag anything platform-specific into it, and this module
// stays platform-free. No name collisions with the seven facade functions
// above (verified against `index.ts`'s export surface).
export * from "./index.ts";
