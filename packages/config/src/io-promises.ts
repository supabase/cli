import { cliConfigIo } from "./promise-io.ts";

/** Resolves the config, `.env`, and `.env.local` paths of the project containing `cwd`, or `null` outside one. */
export const findCliProjectPaths = cliConfigIo.findCliProjectPaths;
/** Resolves the root of the project containing `cwd`, or `null` outside one. */
export const findCliProjectRoot = cliConfigIo.findCliProjectRoot;
/** Loads, interpolates, and validates the project config found from `cwd`, or resolves `null` when there is none. */
export const loadCliConfig = cliConfigIo.loadCliConfig;
/** Loads, interpolates, and validates the config file at `path`. */
export const loadCliConfigFile = cliConfigIo.loadCliConfigFile;
/** Layers the project's dotenv files under the ambient environment, or resolves `null` outside a project. */
export const loadCliProjectEnvironment = cliConfigIo.loadCliProjectEnvironment;
/** Validates `config` and writes it, minus schema defaults, to the project's config file. */
export const saveCliConfig = cliConfigIo.saveCliConfig;
/** Merges the functions discovered under `supabase/functions` with the config's `[functions.*]` overrides. */
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
