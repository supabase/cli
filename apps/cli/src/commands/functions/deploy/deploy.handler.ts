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
  // `--yes` OR `SUPABASE_YES` inside the `--prune` confirm — the env var
  // must auto-confirm too, not just the flag.
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
    // Go: `fmt.Printf("Deployed Functions on project %s: %s\n",
    // utils.Aqua(flags.ProjectRef), …)` (`internal/functions/deploy/deploy.go:70`)
    // — stdout-bound, so the TTY gate must check stdout.
    styleIdentifier: (text) => aqua(text, process.stdout),
    // Go: `utils.Bold` on the `Bundling Function:` slug (`bundle.go:30`, stderr)
    // and the no-functions error dir (`deploy.go:35`, rendered on stderr) —
    // both stderr-bound, matching `bold`'s default TTY gate.
    styleEmphasis: (text) => bold(text),
    // Go: `utils.Yellow` on the `WARNING:` token before "Docker is not
    // running" (`deploy.go:60`, stderr) — matches `yellow`'s default
    // TTY gate.
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
