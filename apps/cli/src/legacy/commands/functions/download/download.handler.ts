import { Effect, Option, Path, Stdio } from "effect";
import {
  downloadFunctions,
  makeGoProxyLegacyBundleArgs,
} from "../../../../shared/functions/download.ts";
import { resolveEdgeRuntimeVersionPin } from "../../../../shared/functions/functions.shared.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { legacyAqua, legacyBold, legacyYellow } from "../../../shared/legacy-colors.ts";
import { legacyFunctionsGoConfigCompat } from "../../../shared/legacy-functions-go-config.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import type { LegacyFunctionsDownloadFlags } from "./download.command.ts";

export const legacyFunctionsDownload = Effect.fn("legacy.functions.download")(function* (
  flags: LegacyFunctionsDownloadFlags,
) {
  const api = yield* LegacyPlatformApi;
  const cliConfig = yield* LegacyCliConfig;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const proxy = yield* LegacyGoProxy;
  const goConfigCompat = yield* legacyFunctionsGoConfigCompat;
  const path = yield* Path.Path;
  const stdio = yield* Stdio.Stdio;
  const rawArgs = yield* stdio.args;
  const edgeRuntimeVersion = yield* resolveEdgeRuntimeVersionPin(
    path.join(cliConfig.workdir, "supabase"),
  );
  let resolvedProjectRef = Option.none<string>();

  yield* downloadFunctions(flags, {
    api,
    projectRoot: cliConfig.workdir,
    rawArgs,
    goConfigCompat,
    edgeRuntimeVersion,
    // Established styling: bold on the `Downloading function:` slug
    // (stderr) — matches `legacyBold`'s default TTY gate.
    styleEmphasis: (text) => legacyBold(text),
    // Established styling: aqua on the suggested `--legacy-bundle` command
    // (stderr) — matches `legacyAqua`'s default TTY gate.
    styleAqua: (text) => legacyAqua(text),
    // Established styling: yellow on the `WARNING:` token before "Docker is
    // not running" (stderr) — matches `legacyYellow`'s default TTY gate.
    styleWarning: (text) => legacyYellow(text),
    resolveProjectRef: (projectRef) =>
      resolver.resolve(projectRef).pipe(
        Effect.tap((ref) =>
          Effect.sync(() => {
            resolvedProjectRef = Option.some(ref);
          }),
        ),
      ),
    // The delegated Go binary runs its own `Execute()` and would otherwise
    // fire its own `cli_command_executed` on top of this command's own
    // `withLegacyCommandInstrumentation` wrapper. Suppress it so proxied
    // invocations record exactly one event, matching Go (mirrors `db pull` /
    // `db diff`'s delegated-call pattern).
    //
    // In machine-output mode the child's stdout is captured and discarded
    // instead of inherited, matching `db pull`/`db diff`'s delegated-call
    // pattern for the CLI-1546 "stdout is payload-only in machine mode"
    // invariant — `downloadFunctions` emits the `Output` envelope itself.
    proxyDownload: (proxyFlags, projectRef, captureOutput) => {
      const args = makeGoProxyLegacyBundleArgs(proxyFlags.functionName, projectRef);
      const env = { SUPABASE_TELEMETRY_DISABLED: "1" };
      return captureOutput
        ? Effect.asVoid(
            proxy.execCapture(args, { env, stdin: "ignore", suppressChildTelemetry: true }),
          )
        : proxy.exec(args, { env, suppressChildTelemetry: true });
    },
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
