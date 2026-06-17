import { DEFAULT_VERSIONS } from "@supabase/stack/effect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Option, Stdio } from "effect";
import { deployFunctions } from "../../../../shared/functions/deploy.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { legacyDashboardUrl } from "../../../shared/legacy-profile.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import type { LegacyFunctionsDeployFlags } from "./deploy.command.ts";

export const legacyFunctionsDeploy = Effect.fn("legacy.functions.deploy")(function* (
  flags: LegacyFunctionsDeployFlags,
) {
  const api = yield* LegacyPlatformApi;
  const cliConfig = yield* LegacyCliConfig;
  const resolver = yield* LegacyProjectRefResolver;
  const yes = yield* LegacyYesFlag;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const runtimeInfo = yield* RuntimeInfo;
  const stdio = yield* Stdio.Stdio;
  const rawArgs = yield* stdio.args;
  const edgeRuntimeVersion = yield* Effect.tryPromise(() =>
    readFile(join(cliConfig.workdir, "supabase", ".temp", "edge-runtime-version"), "utf8"),
  ).pipe(
    Effect.map((version) => version.trim()),
    Effect.catch(() => Effect.succeed("")),
    Effect.map((version) => version || DEFAULT_VERSIONS["edge-runtime"]),
  );
  let resolvedProjectRef = Option.none<string>();

  yield* deployFunctions(flags, {
    api,
    cwd: cliConfig.workdir,
    flagCwd: runtimeInfo.cwd,
    projectRoot: cliConfig.workdir,
    supabaseDir: join(cliConfig.workdir, "supabase"),
    dashboardUrl: legacyDashboardUrl(cliConfig.profile),
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
