import { cliConfigIo } from "./promise-io.ts";

export const findCliProjectPaths = cliConfigIo.findCliProjectPaths;
export const findCliProjectRoot = cliConfigIo.findCliProjectRoot;
export const loadCliConfig = cliConfigIo.loadCliConfig;
export const loadCliConfigFile = cliConfigIo.loadCliConfigFile;
export const loadCliProjectEnvironment = cliConfigIo.loadCliProjectEnvironment;
export const saveCliConfig = cliConfigIo.saveCliConfig;
export const inferFunctionsManifest = cliConfigIo.inferFunctionsManifest;
export {
  CliConfigFileConflictError,
  CliConfigParseError,
  CliConfigRemovedKeyError,
  CliConfigSchemaVersionError,
  CliProjectEnvParseError,
  type CliConfigValidationIssue,
} from "./promise-errors.ts";
export type {
  CliConfigDocument,
  CliConfigIo,
  CliProjectEnvironment,
  CliProjectPaths,
  FunctionsManifest,
  LoadCliConfigOptions,
  LoadCliProjectEnvironmentOptions,
  LoadedCliConfig,
  ResolvedFunctionConfig,
  SaveCliConfigOptions,
} from "./promise-io.ts";
