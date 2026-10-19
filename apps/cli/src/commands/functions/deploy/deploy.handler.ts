import { Effect, Option, Path, Ref, Stdio } from "effect";
import { deployFunctions } from "../../../shared/functions/deploy.ts";
import { resolveEdgeRuntimeVersionPin } from "../../../shared/functions/functions.shared.ts";
import { aqua, bold, yellow } from "../../../command-internal/colors.ts";
import { functionsLocalConfigLoader } from "../../../command-internal/functions-local-config.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { resolveProjectTarget } from "../../../command-internal/target/resolve-project-target.ts";
import { dashboardUrl } from "../../../command-internal/profile.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import type { FunctionsDeployFlags } from "./deploy.command.ts";

export const functionsDeploy = Effect.fn("functions.deploy")(function* (
  flags: FunctionsDeployFlags,
) {
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const runtimeInfo = yield* RuntimeInfo;
  const stdio = yield* Stdio.Stdio;
  const path = yield* Path.Path;
  const rawArgs = yield* stdio.args;
  const edgeRuntimeVersion = yield* resolveEdgeRuntimeVersionPin(
    path.join(cliSettings.workdir, "supabase"),
  );
  const resolvedProjectRef = yield* Ref.make(Option.none<string>());

  yield* deployFunctions(flags, {
    api,
    cwd: cliSettings.workdir,
    flagCwd: runtimeInfo.cwd,
    projectRoot: cliSettings.workdir,
    supabaseDir: path.join(cliSettings.workdir, "supabase"),
    dashboardUrl: dashboardUrl(cliSettings.profile),
    localConfigLoader: functionsLocalConfigLoader,
    rawArgs,
    edgeRuntimeVersion,
    resolveProjectRef: () =>
      resolveProjectTarget({ remote: flags.remote, projectRef: flags.projectRef }).pipe(
        Effect.tap((ref) => Ref.set(resolvedProjectRef, Option.some(ref))),
      ),
    // Written to stdout, so the TTY color gate must check stdout.
    styleIdentifier: (text) => aqua(text, process.stdout),
    // Written to stderr, matching `bold`'s default TTY gate.
    styleEmphasis: (text) => bold(text),
    // Written to stderr, matching `yellow`'s default TTY gate.
    styleWarning: (text) => yellow(text),
  }).pipe(
    Effect.ensuring(
      Ref.get(resolvedProjectRef).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (ref) =>
              Effect.annotateCurrentSpan("project.ref", ref).pipe(
                Effect.andThen(linkedProjectCache.cache(ref)),
              ),
          }),
        ),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
