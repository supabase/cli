import { join } from "node:path";
import { Effect, Option, Stdio } from "effect";
import { deployFunctions } from "../../../../shared/functions/deploy.ts";
import { resolveEdgeRuntimeVersionPin } from "../../../../shared/functions/functions.shared.ts";
import { legacyAqua, legacyBold } from "../../../shared/legacy-colors.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
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
  const cliConfig = yield* LegacyCliConfig;
  const resolver = yield* LegacyProjectRefResolver;
  // `--yes` OR `SUPABASE_YES` (Go's `viper.GetBool("YES")` inside the `--prune`
  // confirm, `deploy.go:190` + root.go:318-320) — the env var must auto-confirm
  // too, not just the flag (CLI-1974).
  const yes = yield* legacyResolveYes;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const runtimeInfo = yield* RuntimeInfo;
  const stdio = yield* Stdio.Stdio;
  const rawArgs = yield* stdio.args;
  const edgeRuntimeVersion = yield* resolveEdgeRuntimeVersionPin(
    join(cliConfig.workdir, "supabase"),
  );
  let resolvedProjectRef = Option.none<string>();

  yield* deployFunctions(flags, {
    api,
    cwd: cliConfig.workdir,
    flagCwd: runtimeInfo.cwd,
    projectRoot: cliConfig.workdir,
    supabaseDir: join(cliConfig.workdir, "supabase"),
    dashboardUrl: legacyDashboardUrl(cliConfig.profile),
    goViperCompat: true,
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
