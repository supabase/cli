import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Layer } from "effect";
import { makeCliConfigIo, type CliConfigIo } from "./promise-facade.ts";

const cliConfigIo: CliConfigIo = makeCliConfigIo(
  Layer.mergeAll(BunFileSystem.layer, BunPath.layer),
);

export const loadCliConfig = cliConfigIo.loadCliConfig;
export const findProjectRootFor = cliConfigIo.findProjectRootFor;
export const findProjectPathsFor = cliConfigIo.findProjectPathsFor;
export const loadCliConfigFile = cliConfigIo.loadCliConfigFile;
export const loadProjectEnvironmentFor = cliConfigIo.loadProjectEnvironmentFor;
export const saveCliConfig = cliConfigIo.saveCliConfig;
export const loadFunctionsManifest = cliConfigIo.loadFunctionsManifest;
export type { CliConfigIo } from "./promise-facade.ts";
// Re-exports every pure symbol from `.` (types, schema, errors, etc.) so
// `./io` consumers can name `LoadedCliConfig`/`ProjectPaths`/etc. without
// a second import from `@supabase/config` — `index.ts`'s own graph is pure,
// so this doesn't drag anything platform-specific into it. No name
// collisions with the seven facade functions above (verified against
// `index.ts`'s export surface).
export * from "./index.ts";
