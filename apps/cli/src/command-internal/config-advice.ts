import type { ConfigFormat } from "@supabase/config/effect";
import { cliConfigFormatForPath } from "@supabase/config/internal";
import type { Path } from "effect";

/** The project config file a message points at: its format and workdir-relative path. */
export interface ConfigFileRef {
  readonly format: ConfigFormat;
  readonly path: string;
}

/** Where `supabase init` writes the config, so the file a project without one will get. */
export const DEFAULT_CONFIG_FILE: ConfigFileRef = {
  format: "toml",
  path: "supabase/config.toml",
};

/** The config file at an absolute `configPath`; `undefined` reads as no file. */
export const configFileRefFromPath = (
  path: Path.Path,
  workdir: string,
  configPath: string | undefined,
): ConfigFileRef =>
  configPath === undefined
    ? DEFAULT_CONFIG_FILE
    : { format: cliConfigFormatForPath(configPath), path: path.relative(workdir, configPath) };

export const configFileRefOf = (
  path: Path.Path,
  workdir: string,
  resolvedConfig: {
    readonly hasConfigFile: boolean;
    readonly loaded: { readonly path: string };
  },
): ConfigFileRef =>
  configFileRefFromPath(
    path,
    workdir,
    resolvedConfig.hasConfigFile ? resolvedConfig.loaded.path : undefined,
  );

/** A setting as advice reads it: `[section] key = value` in TOML, `` `section.key` to `value` `` in JSON. */
export const configSetting = (
  format: ConfigFormat,
  section: string,
  key: string,
  value: string,
): string =>
  format === "json" ? `\`${section}.${key}\` to \`${value}\`` : `[${section}] ${key} = ${value}`;

/** A setting's key as advice names it: `[section].key` in TOML, `section.key` in JSON. */
export const configKey = (format: ConfigFormat, section: string, key: string): string =>
  format === "json" ? `${section}.${key}` : `[${section}].${key}`;

/** The config file name without its directory, as "not declared" notes name it. */
export const configFileName = (configPath: string): string =>
  configPath.split(/[\\/]/).pop() ?? configPath;
