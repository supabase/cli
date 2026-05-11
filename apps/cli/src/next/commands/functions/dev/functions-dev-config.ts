import { basename, dirname, resolve } from "node:path";
import type { FunctionsConfig } from "@supabase/stack/effect";
import { Effect, Option } from "effect";
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

export function toStackFunctionsConfig(opts: FunctionsDevConfigOptions): FunctionsConfig {
  return {
    envFile: Option.match(opts.envFile, {
      onNone: () => undefined,
      onSome: (path) => path,
    }),
    noVerifyJwt: opts.noVerifyJwt,
  };
}

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
