import { loadCliProjectEnvironment } from "@supabase/config/effect";
import { Effect, Layer, Option } from "effect";
import { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import { CliProjectContext } from "./cli-project-context.service.ts";

const emptyCliProjectContext = CliProjectContext.of({
  paths: Option.none(),
  projectEnv: Option.none(),
});

const makeCliProjectContext = Effect.gen(function* () {
  const runtimeInfo = yield* RuntimeInfo;
  const projectEnv = yield* loadCliProjectEnvironment({
    cwd: runtimeInfo.cwd,
    baseEnv: process.env,
  });

  if (projectEnv === null) {
    return emptyCliProjectContext;
  }

  return CliProjectContext.of({
    paths: Option.some(projectEnv.paths),
    projectEnv: Option.some(projectEnv),
  });
});

export const cliProjectContextLayer = Layer.effect(CliProjectContext, makeCliProjectContext);
