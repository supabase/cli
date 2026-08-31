import { Effect, Stdio } from "effect";
import { CliSettings } from "../../../config/cli-settings.service.ts";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import { CliProjectHome } from "../../../config/cli-project-home.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { deployFunctions } from "../../../../shared/functions/deploy.ts";
import { resolveEdgeRuntimeVersionPin } from "../../../../shared/functions/functions.shared.ts";
import { resolveProjectRef } from "../functions.shared.ts";
import type { FunctionsDeployFlags } from "./deploy.command.ts";

export const functionsDeploy = Effect.fn("functions.deploy")(function* (
  flags: FunctionsDeployFlags,
) {
  const api = yield* PlatformApi;
  const cliSettings = yield* CliSettings;
  const cliProjectHome = yield* CliProjectHome;
  const runtimeInfo = yield* RuntimeInfo;
  const stdio = yield* Stdio.Stdio;
  const rawArgs = yield* stdio.args;
  const edgeRuntimeVersion = yield* resolveEdgeRuntimeVersionPin(cliProjectHome.supabaseDir);

  yield* deployFunctions(flags, {
    api,
    cwd: cliProjectHome.projectRoot,
    flagCwd: runtimeInfo.cwd,
    projectRoot: cliProjectHome.projectRoot,
    supabaseDir: cliProjectHome.supabaseDir,
    dashboardUrl: cliSettings.dashboardUrl,
    goConfigCompat: undefined,
    yes: flags.yes,
    rawArgs,
    edgeRuntimeVersion,
    resolveProjectRef,
  });
});
