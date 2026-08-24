import {
  inferFunctionsManifest,
  loadDotEnvFile,
  loadProjectConfig,
  loadProjectEnvironment,
  resolveProjectSubtree,
} from "@supabase/config";
import type { ResolvedFunctionsBundle } from "@supabase/stack/effect";
import { ConfigProvider, Effect, Option, Path, Redacted } from "effect";
import { ProjectHome } from "../../../config/project-home.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { collectConfigEnvironment } from "../../../../shared/runtime/config-environment.ts";

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

function absoluteProjectPath(pathService: Path.Path, supabaseDir: string, path: string): string {
  const withoutDotSlash = path.startsWith("./") ? path.slice(2) : path;
  return pathService.resolve(supabaseDir, withoutDotSlash);
}

export const resolveFunctionsBundle = Effect.fnUntraced(function* (
  opts: FunctionsDevConfigOptions,
) {
  const projectHome = yield* ProjectHome;
  const runtimeInfo = yield* RuntimeInfo;
  const path = yield* Path.Path;
  const provider = yield* ConfigProvider.ConfigProvider;
  const baseEnv = yield* collectConfigEnvironment(provider);
  const projectEnvironment = yield* loadProjectEnvironment({
    cwd: projectHome.projectRoot,
    baseEnv,
  });
  const loadedConfig = yield* loadProjectConfig(projectHome.projectRoot, {
    projectEnv: projectEnvironment ?? undefined,
  });
  const projectConfig =
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
    ...(projectConfig === undefined ? {} : { config: projectConfig }),
  });
  const envFilePath = Option.match(opts.envFile, {
    onNone: () => path.join(projectHome.supabaseDir, "functions", ".env"),
    onSome: (envFile) => path.resolve(runtimeInfo.cwd, envFile),
  });
  const loadedEnv = yield* loadDotEnvFile(envFilePath);

  return {
    env: loadedEnv,
    functions: Object.entries(manifest)
      .filter(([, config]) => config.enabled)
      .map(([name, config]) => ({
        name,
        verifyJWT: opts.noVerifyJwt ? false : config.verify_jwt,
        entrypointPath: absoluteProjectPath(path, projectHome.supabaseDir, config.entrypoint),
        importMapPath:
          config.import_map === ""
            ? null
            : absoluteProjectPath(path, projectHome.supabaseDir, config.import_map),
        staticFiles: config.static_files.map((staticPath) =>
          absoluteProjectPath(path, projectHome.supabaseDir, staticPath),
        ),
        env: config.env,
      })),
  } satisfies ResolvedFunctionsBundle;
});

export const functionsDevWatchPaths = Effect.fnUntraced(function* (envFile: Option.Option<string>) {
  const projectHome = yield* ProjectHome;
  const runtimeInfo = yield* RuntimeInfo;
  const path = yield* Path.Path;

  return [
    {
      path: projectHome.supabaseDir,
      names: ["functions", "config.toml", "config.json"],
    },
    ...(Option.isSome(envFile)
      ? (() => {
          const envFilePath = path.resolve(runtimeInfo.cwd, envFile.value);
          return [
            {
              path: path.dirname(envFilePath),
              names: [path.basename(envFilePath)],
            },
          ];
        })()
      : []),
  ];
});
