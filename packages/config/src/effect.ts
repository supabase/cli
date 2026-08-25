// Effect-native surface — superset of the default entrypoint.
export * from "./index.ts";
export {
  configJsonPath,
  configTomlPath,
  loadProjectConfig,
  loadProjectConfigFile,
  saveProjectConfig,
} from "./io.ts";
export { inferFunctionsManifest } from "./functions-manifest.ts";
export {
  loadDotEnvFile,
  loadProjectEnvironment,
  resolveProjectSubtree,
  resolveProjectValue,
} from "./project.ts";
export { findProjectPaths, findProjectRoot } from "./paths.ts";
export { projectConfigStoreLayer } from "./project-config.layer.ts";
export { ProjectConfigStore } from "./project-config.service.ts";
