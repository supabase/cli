import { Effect, Stdio } from "effect";
import { CliConfig } from "../../../config/cli-config.service.ts";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import { ProjectHome } from "../../../config/project-home.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { deployFunctions } from "../../../../shared/functions/deploy.ts";
import { resolveEdgeRuntimeVersionPin } from "../../../../shared/functions/functions.shared.ts";
import { resolveProjectRef } from "../../../config/resolve-project-ref.ts";
import type { FunctionsDeployFlags } from "./deploy.command.ts";

export const functionsDeploy = Effect.fn("functions.deploy")(function* (
  flags: FunctionsDeployFlags,
) {
  const api = yield* PlatformApi;
  const cliConfig = yield* CliConfig;
  const projectHome = yield* ProjectHome;
  const runtimeInfo = yield* RuntimeInfo;
  const stdio = yield* Stdio.Stdio;
  const rawArgs = yield* stdio.args;
  const edgeRuntimeVersion = yield* resolveEdgeRuntimeVersionPin(projectHome.supabaseDir);

  yield* deployFunctions(flags, {
    api,
    cwd: projectHome.projectRoot,
    flagCwd: runtimeInfo.cwd,
    projectRoot: projectHome.projectRoot,
    supabaseDir: projectHome.supabaseDir,
    dashboardUrl: cliConfig.dashboardUrl,
    goConfigCompat: undefined,
    yes: flags.yes,
    rawArgs,
    edgeRuntimeVersion,
    resolveProjectRef,
  });
});
