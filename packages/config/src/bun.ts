import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Layer } from "effect";
import { makeProjectConfigIo, type ProjectConfigIo } from "./promise-facade.ts";

const projectConfigIo: ProjectConfigIo = makeProjectConfigIo(
  Layer.mergeAll(BunFileSystem.layer, BunPath.layer),
);

export const loadProjectConfig = projectConfigIo.loadProjectConfig;
export const findProjectRootFor = projectConfigIo.findProjectRootFor;
export const findProjectPathsFor = projectConfigIo.findProjectPathsFor;
export const loadProjectConfigFile = projectConfigIo.loadProjectConfigFile;
export const loadProjectEnvironmentFor = projectConfigIo.loadProjectEnvironmentFor;
export const saveProjectConfig = projectConfigIo.saveProjectConfig;
export const loadFunctionsManifest = projectConfigIo.loadFunctionsManifest;
export type { ProjectConfigIo } from "./promise-facade.ts";
// Re-exports every pure symbol from `.` (types, schema, errors, etc.) so
// `./io` consumers can name `LoadedProjectConfig`/`ProjectPaths`/etc. without
// a second import from `@supabase/config` — `index.ts`'s own graph is pure,
// so this doesn't drag anything platform-specific into it. No name
// collisions with the seven facade functions above (verified against
// `index.ts`'s export surface).
export * from "./index.ts";
