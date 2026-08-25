import {
  inferFunctionsManifest,
  loadDotEnvFile,
  loadCliConfig,
  loadCliProjectEnvironment,
  resolveCliConfigSubtree,
} from "@supabase/config/effect";
import type { ResolvedFunctionsBundle } from "@supabase/stack/effect";
import { Effect, Option, Redacted } from "effect";
import { basename, dirname, join, resolve } from "node:path";
import { CliProjectHome } from "../../../config/cli-project-home.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";

export interface FunctionsDevConfigOptions {
  readonly envFile: Option.Option<string>;
  readonly noVerifyJwt: boolean;
}

export interface FunctionsDevWatchPath {
  readonly path: string;
  readonly names?: ReadonlyArray<string>;
}

function reveal(value: string | Redacted.Redacted<string>): string {
  return Redacted.isRedacted(value) ? Redacted.value(value) : value;
}

function absoluteProjectPath(supabaseDir: string, path: string): string {
  const withoutDotSlash = path.startsWith("./") ? path.slice(2) : path;
  return resolve(supabaseDir, withoutDotSlash);
}

export const resolveFunctionsBundle = Effect.fnUntraced(function* (
  opts: FunctionsDevConfigOptions,
) {
  const cliProjectHome = yield* CliProjectHome;
  const runtimeInfo = yield* RuntimeInfo;
  const cliProjectEnvironment = yield* loadCliProjectEnvironment({
    cwd: cliProjectHome.projectRoot,
    baseEnv: process.env,
  });
  const loadedConfig = yield* loadCliConfig(cliProjectHome.projectRoot);
  const cliConfig =
    cliProjectEnvironment === null || loadedConfig === null
      ? undefined
      : {
          ...loadedConfig.config,
          functions: Object.fromEntries(
            Object.entries(
              yield* resolveCliConfigSubtree(
                loadedConfig.config.functions,
                cliProjectEnvironment,
                "functions",
              ),
            ).map(([name, config]) => [
              name,
              {
                ...config,
                entrypoint: reveal(config.entrypoint),
                import_map: reveal(config.import_map),
                static_files: config.static_files.map(reveal),
                env: Object.fromEntries(
                  Object.entries(config.env).map(([key, value]) => [key, reveal(value)]),
                ),
              },
            ]),
          ),
        };
  const manifest = yield* inferFunctionsManifest({
    cwd: cliProjectHome.projectRoot,
    ...(cliConfig === undefined ? {} : { config: cliConfig }),
  });
  const envFilePath = Option.match(opts.envFile, {
    onNone: () => join(cliProjectHome.supabaseDir, "functions", ".env"),
    onSome: (path) => resolve(runtimeInfo.cwd, path),
  });

  return {
    env: yield* loadDotEnvFile(envFilePath),
    functions: Object.entries(manifest)
      .filter(([, config]) => config.enabled)
      .map(([name, config]) => ({
        name,
        verifyJWT: opts.noVerifyJwt ? false : config.verify_jwt,
        entrypointPath: absoluteProjectPath(cliProjectHome.supabaseDir, config.entrypoint),
        importMapPath:
          config.import_map === ""
            ? null
            : absoluteProjectPath(cliProjectHome.supabaseDir, config.import_map),
        staticFiles: config.static_files.map((path) =>
          absoluteProjectPath(cliProjectHome.supabaseDir, path),
        ),
        env: config.env,
      })),
  } satisfies ResolvedFunctionsBundle;
});

export const functionsDevWatchPaths = Effect.fnUntraced(function* (envFile: Option.Option<string>) {
  const cliProjectHome = yield* CliProjectHome;
  const runtimeInfo = yield* RuntimeInfo;

  return [
    {
      path: cliProjectHome.supabaseDir,
      names: ["functions", "config.toml", "config.json"],
    },
    ...(Option.isSome(envFile)
      ? (() => {
          const envFilePath = resolve(runtimeInfo.cwd, envFile.value);
          return [
            {
              path: dirname(envFilePath),
              names: [basename(envFilePath)],
            },
          ];
        })()
      : []),
  ];
});
