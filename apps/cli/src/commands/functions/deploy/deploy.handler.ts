import { join } from "node:path";
import { Effect, Option, Stdio } from "effect";
import { deployFunctions } from "../../../shared/functions/deploy.ts";
import { resolveEdgeRuntimeVersionPin } from "../../../shared/functions/functions.shared.ts";
import { aqua, bold, yellow } from "../../../command-internal/colors.ts";
import { functionsGoConfigCompat } from "../../../command-internal/functions-go-config.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { resolveYes } from "../../../command-internal/global-flags.ts";
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
  const resolver = yield* ProjectRefResolver;
  // Also honors `SUPABASE_YES`, not just the `--yes` flag, for the `--prune` confirm.
  const yes = yield* resolveYes;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const runtimeInfo = yield* RuntimeInfo;
  const stdio = yield* Stdio.Stdio;
  const rawArgs = yield* stdio.args;
  const edgeRuntimeVersion = yield* resolveEdgeRuntimeVersionPin(
    join(cliSettings.workdir, "supabase"),
  );
  let resolvedProjectRef = Option.none<string>();

  yield* deployFunctions(flags, {
    api,
    cwd: cliSettings.workdir,
    flagCwd: runtimeInfo.cwd,
    projectRoot: cliSettings.workdir,
    supabaseDir: join(cliSettings.workdir, "supabase"),
    dashboardUrl: dashboardUrl(cliSettings.profile),
    goConfigCompat: functionsGoConfigCompat,
    yes,
    rawArgs,
    edgeRuntimeVersion,
    resolveProjectRef: (projectRef) =>
      resolver.resolve(projectRef).pipe(
        Effect.tap((ref) =>
          Effect.sync(() => {
            resolvedProjectRef = Option.some(ref);
          }),
        ),
      ),
    // Written to stdout, so the TTY color gate must check stdout.
    styleIdentifier: (text) => aqua(text, process.stdout),
    // Written to stderr, matching `bold`'s default TTY gate.
    styleEmphasis: (text) => bold(text),
    // Written to stderr, matching `yellow`'s default TTY gate.
    styleWarning: (text) => yellow(text),
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        Option.match(resolvedProjectRef, {
          onNone: () => Effect.void,
          onSome: (ref) => linkedProjectCache.cache(ref),
        }),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
