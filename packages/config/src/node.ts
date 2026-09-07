import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Layer } from "effect";
import { makeCliConfigIo, type CliConfigIo } from "./promise-facade.ts";

const cliConfigIo: CliConfigIo = makeCliConfigIo(
  Layer.mergeAll(NodeFileSystem.layer, NodePath.layer),
);

export const loadCliConfig = cliConfigIo.loadCliConfig;
export const findCliProjectRoot = cliConfigIo.findCliProjectRoot;
export const findCliProjectPaths = cliConfigIo.findCliProjectPaths;
export const loadCliConfigFile = cliConfigIo.loadCliConfigFile;
export const loadCliProjectEnvironment = cliConfigIo.loadCliProjectEnvironment;
export const saveCliConfig = cliConfigIo.saveCliConfig;
export const inferFunctionsManifest = cliConfigIo.inferFunctionsManifest;
export type { CliConfigIo } from "./promise-facade.ts";
// Re-exports every pure symbol from `.` (types, schema, errors, etc.) so
// `./io` consumers can name `LoadedCliConfig`/`CliProjectPaths`/etc. without
// a second import from `@supabase/config` — `index.ts`'s own graph is pure,
// so this doesn't drag anything platform-specific into it. No name
// collisions with the seven facade functions above (verified against
// `index.ts`'s export surface).
export * from "./index.ts";
