import {
  inferFunctionsManifest,
  loadDotEnvFile,
  loadCliConfig,
  loadProjectEnvironment,
  resolveProjectSubtree,
} from "@supabase/config/effect";
import type { ResolvedFunctionsBundle } from "@supabase/stack/effect";
import { Effect, Option, Redacted } from "effect";
import { basename, dirname, join, resolve } from "node:path";
import { ProjectHome } from "../../../config/project-home.service.ts";
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
  const projectHome = yield* ProjectHome;
  const runtimeInfo = yield* RuntimeInfo;
  const projectEnvironment = yield* loadProjectEnvironment({
    cwd: projectHome.projectRoot,
    baseEnv: process.env,
  });
  const loadedConfig = yield* loadCliConfig(projectHome.projectRoot);
  const cliConfig =
    projectEnvironment === null || loadedConfig === null
      ? undefined
      : {
          ...loadedConfig.config,
          functions: Object.fromEntries(
            Object.entries(
              yield* resolveProjectSubtree(
                loadedConfig.config.functions,
                projectEnvironment,
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
    cwd: projectHome.projectRoot,
    ...(cliConfig === undefined ? {} : { config: cliConfig }),
  });
  const envFilePath = Option.match(opts.envFile, {
    onNone: () => join(projectHome.supabaseDir, "functions", ".env"),
    onSome: (path) => resolve(runtimeInfo.cwd, path),
  });

  return {
    env: yield* loadDotEnvFile(envFilePath),
    functions: Object.entries(manifest)
      .filter(([, config]) => config.enabled)
      .map(([name, config]) => ({
        name,
        verifyJWT: opts.noVerifyJwt ? false : config.verify_jwt,
        entrypointPath: absoluteProjectPath(projectHome.supabaseDir, config.entrypoint),
        importMapPath:
          config.import_map === ""
            ? null
            : absoluteProjectPath(projectHome.supabaseDir, config.import_map),
        staticFiles: config.static_files.map((path) =>
          absoluteProjectPath(projectHome.supabaseDir, path),
        ),
        env: config.env,
      })),
  } satisfies ResolvedFunctionsBundle;
});

export const functionsDevWatchPaths = Effect.fnUntraced(function* (envFile: Option.Option<string>) {
  const projectHome = yield* ProjectHome;
  const runtimeInfo = yield* RuntimeInfo;

  return [
    {
      path: projectHome.supabaseDir,
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
