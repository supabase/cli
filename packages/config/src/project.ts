import { Effect, FileSystem } from "effect";
import { CliProjectEnvParseError } from "./errors.ts";
import {
  layerProjectEnvironment,
  parseDotEnvText,
  type CliProjectEnvSource,
} from "./lib/dotenv.ts";
import {
  resolveCliConfigValueAtPath,
  toPathSegments,
  type ResolvedCliConfigValue,
} from "./lib/resolve.ts";
import { findCliProjectPaths, type CliProjectPaths } from "./paths.ts";

export interface CliProjectEnvironment {
  readonly paths: CliProjectPaths;
  readonly values: Readonly<Record<string, string>>;
  readonly loadedPaths: ReadonlyArray<string>;
  readonly sources: Readonly<Record<string, CliProjectEnvSource>>;
}

const parseDotEnv = Effect.fnUntraced(function* (path: string, contents: string) {
  const parsed = parseDotEnvText(contents);
  if ("errorLine" in parsed) {
    return yield* new CliProjectEnvParseError({ path, line: parsed.errorLine });
  }
  return parsed.values;
});

/** Parse one explicit dotenv file without applying ambient or project-local precedence. */
export const loadDotEnvFile = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path))) {
    return {};
  }
  return yield* parseDotEnv(path, yield* fs.readFileString(path));
});

export interface LoadCliProjectEnvironmentOptions {
  readonly cwd: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** See {@link FindCliProjectPathsOptions.search}. */
  readonly search?: boolean;
  /**
   * Skip reading/parsing `paths.envLocalPath` (`supabase/.env.local`) entirely, so a
   * malformed or intentionally non-test `.env.local` cannot fail config loading. Defaults
   * to `false`.
   */
  readonly skipEnvLocal?: boolean;
}

/** Not covered by semver — exported from `@supabase/config/internal` only. */
export interface InternalResolveCliConfigOptions {
  /**
   * Opt into the CLI's case-agnostic `env()` matching (`^env\((.*)\)$`). Defaults to
   * `false`, which requires SCREAMING_SNAKE_CASE.
   */
  readonly cliCompat?: boolean;
}

export const loadCliProjectEnvironment = Effect.fn("ProjectEnvironment.load")(function* (
  options: LoadCliProjectEnvironmentOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* findCliProjectPaths(options.cwd, { search: options.search });

  if (paths === null) {
    return null;
  }

  let env: Readonly<Record<string, string>> | undefined;
  let envLocal: Readonly<Record<string, string>> | undefined;
  const loadedPaths: string[] = [];

  if (yield* fs.exists(paths.envPath)) {
    env = yield* parseDotEnv(paths.envPath, yield* fs.readFileString(paths.envPath));
    loadedPaths.push(paths.envPath);
  }

  if (!options.skipEnvLocal && (yield* fs.exists(paths.envLocalPath))) {
    envLocal = yield* parseDotEnv(paths.envLocalPath, yield* fs.readFileString(paths.envLocalPath));
    loadedPaths.push(paths.envLocalPath);
  }

  const { values, sources } = layerProjectEnvironment({ env, envLocal, baseEnv: options.baseEnv });

  return {
    paths,
    values,
    loadedPaths,
    sources,
  } satisfies CliProjectEnvironment;
});

/**
 * Effect-typed counterpart of the plain sync `resolveCliConfigValue` in
 * `./lib/resolve.ts`, additionally accepting the internal-only `cliCompat` option.
 *
 * Accepts `Pick<CliProjectEnvironment, "values">` so a caller with only a project's env
 * values, not the full loaded object, can pass `{ values }` directly.
 */
export function resolveCliConfigValue<T>(
  value: T,
  cliProjectEnv: Pick<CliProjectEnvironment, "values">,
  configPath: string,
  options?: InternalResolveCliConfigOptions,
): Effect.Effect<ResolvedCliConfigValue<T>> {
  return Effect.sync(() =>
    resolveCliConfigValueAtPath(
      value,
      cliProjectEnv,
      toPathSegments(configPath),
      options?.cliCompat ?? false,
    ),
  );
}

/** See {@link resolveCliConfigValue}'s doc comment for why `cliProjectEnv` only needs `.values`. */
export function resolveCliConfigSubtree<T>(
  value: T,
  cliProjectEnv: Pick<CliProjectEnvironment, "values">,
  pathPrefix: string,
  options?: InternalResolveCliConfigOptions,
): Effect.Effect<ResolvedCliConfigValue<T>> {
  return Effect.sync(() =>
    resolveCliConfigValueAtPath(
      value,
      cliProjectEnv,
      toPathSegments(pathPrefix),
      options?.cliCompat ?? false,
    ),
  );
}
