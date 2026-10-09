import type { CliProjectEnvironment } from "@supabase/config";
import {
  decodeCliConfigDocumentForValidationEffect as decodeDocumentWithCompat,
  loadCliConfig as loadConfigWithCompat,
  resolveCliConfigSubtree as resolveSubtreeWithCompat,
  resolveCliConfigValue as resolveValueWithCompat,
  type DecodeCliConfigDocumentForValidationEffectOptions,
  type InternalLoadCliConfigOptions,
} from "@supabase/config/internal";

export type CliConfigLoadOptions = Omit<InternalLoadCliConfigOptions, "cliCompat">;
export type CliConfigValidationOptions = Omit<
  DecodeCliConfigDocumentForValidationEffectOptions,
  "cliCompat"
>;

/** The single `apps/cli` entrypoint that loads config with the CLI's own loader semantics. */
export const loadCliConfig = (cwd: string, options?: CliConfigLoadOptions) =>
  loadConfigWithCompat(cwd, { ...options, cliCompat: true });

/** Decodes a pending document with the same semantics as {@link loadCliConfig}. */
export const decodeCliConfigDocumentForValidation = (
  document: Record<string, unknown>,
  options: CliConfigValidationOptions,
) => decodeDocumentWithCompat(document, { ...options, cliCompat: true });

export const resolveCliConfigValue = <T>(
  value: T,
  cliProjectEnv: Pick<CliProjectEnvironment, "values">,
  configPath: string,
) => resolveValueWithCompat(value, cliProjectEnv, configPath, { cliCompat: true });

export const resolveCliConfigSubtree = <T>(
  value: T,
  cliProjectEnv: Pick<CliProjectEnvironment, "values">,
  pathPrefix: string,
) => resolveSubtreeWithCompat(value, cliProjectEnv, pathPrefix, { cliCompat: true });
