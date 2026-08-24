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
