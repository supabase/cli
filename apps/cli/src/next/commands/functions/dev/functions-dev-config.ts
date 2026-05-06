import { join, resolve } from "node:path";
import type { FunctionsConfig } from "@supabase/stack/effect";
import { Effect, Option } from "effect";
import { ProjectHome } from "../../../config/project-home.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";

export interface FunctionsDevConfigOptions {
  readonly envFile: Option.Option<string>;
  readonly noVerifyJwt: boolean;
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
    join(projectHome.supabaseDir, "functions"),
    join(projectHome.supabaseDir, "config.toml"),
    join(projectHome.supabaseDir, "functions", ".env"),
    ...(Option.isSome(envFile) ? [resolve(runtimeInfo.cwd, envFile.value)] : []),
  ];
});
