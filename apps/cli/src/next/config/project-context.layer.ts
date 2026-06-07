import { loadProjectEnvironment } from "@supabase/config";
import { Effect, Layer, Option } from "effect";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { ProjectContext } from "./project-context.service.ts";

const emptyProjectContext = ProjectContext.of({
  paths: Option.none(),
  projectEnv: Option.none(),
});

const makeProjectContext = Effect.gen(function* () {
  const runtimeInfo = yield* RuntimeInfo;
  const projectEnv = yield* loadProjectEnvironment({
    cwd: runtimeInfo.cwd,
    baseEnv: process.env,
  });

  if (projectEnv === null) {
    return emptyProjectContext;
  }

  return ProjectContext.of({
    paths: Option.some(projectEnv.paths),
    projectEnv: Option.some(projectEnv),
  });
});

export const projectContextLayer = Layer.effect(ProjectContext, makeProjectContext);
