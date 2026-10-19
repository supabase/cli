import { findCliProjectPaths } from "@supabase/config/effect";
import { Effect, Layer, Option } from "effect";
import { RuntimeInfo } from "../runtime/runtime-info.service.ts";
import { loadCliProjectEnvFiles, readShellEnvironment } from "./cli-config-env.ts";
import { CliProjectContext } from "./cli-project-context.service.ts";

const emptyCliProjectContext = CliProjectContext.of({
  paths: Option.none(),
  projectEnv: Option.none(),
});

const makeCliProjectContext = Effect.gen(function* () {
  const runtimeInfo = yield* RuntimeInfo;
  const paths = yield* findCliProjectPaths(runtimeInfo.cwd);

  if (paths === null) {
    return emptyCliProjectContext;
  }

  const shell = yield* readShellEnvironment();
  const files = yield* loadCliProjectEnvFiles(paths.projectRoot, { shell });

  return CliProjectContext.of({
    paths: Option.some(paths),
    projectEnv: Option.some({ values: files.values }),
  });
});

export const cliProjectContextLayer = Layer.effect(
  CliProjectContext,
  makeCliProjectContext.pipe(Effect.withSpan("CliProjectContext.load")),
);
