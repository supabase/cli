import { join } from "node:path";
import { Effect, Option, Stdio } from "effect";
import { deployFunctions } from "../../../../shared/functions/deploy.ts";
import { resolveEdgeRuntimeVersionPin } from "../../../../shared/functions/functions.shared.ts";
import { legacyAqua, legacyBold, legacyYellow } from "../../../shared/legacy-colors.ts";
import { legacyFunctionsGoConfigCompat } from "../../../shared/legacy-functions-go-config.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyResolveYes } from "../../../../shared/legacy/global-flags.ts";
import { legacyDashboardUrl } from "../../../shared/legacy-profile.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import type { LegacyFunctionsDeployFlags } from "./deploy.command.ts";

export const legacyFunctionsDeploy = Effect.fn("legacy.functions.deploy")(function* (
  flags: LegacyFunctionsDeployFlags,
) {
  const api = yield* LegacyPlatformApi;
  const cliSettings = yield* LegacyCliSettings;
  const resolver = yield* LegacyProjectRefResolver;
  // `--yes` OR `SUPABASE_YES` inside the `--prune` confirm — the env var
  // must auto-confirm too, not just the flag.
  const yes = yield* legacyResolveYes;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
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
    dashboardUrl: legacyDashboardUrl(cliSettings.profile),
    goConfigCompat: legacyFunctionsGoConfigCompat,
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
    // Go: `fmt.Printf("Deployed Functions on project %s: %s\n",
    // utils.Aqua(flags.ProjectRef), …)` (`internal/functions/deploy/deploy.go:70`)
    // — stdout-bound, so the TTY gate must check stdout.
    styleIdentifier: (text) => legacyAqua(text, process.stdout),
    // Go: `utils.Bold` on the `Bundling Function:` slug (`bundle.go:30`, stderr)
    // and the no-functions error dir (`deploy.go:35`, rendered on stderr) —
    // both stderr-bound, matching `legacyBold`'s default TTY gate.
    styleEmphasis: (text) => legacyBold(text),
    // Go: `utils.Yellow` on the `WARNING:` token before "Docker is not
    // running" (`deploy.go:60`, stderr) — matches `legacyYellow`'s default
    // TTY gate.
    styleWarning: (text) => legacyYellow(text),
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
