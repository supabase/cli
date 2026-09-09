import { join } from "node:path";
import { Effect, Option, Stdio } from "effect";
import {
  downloadFunctions,
  makeGoProxyLegacyBundleArgs,
} from "../../../shared/functions/download.ts";
import { resolveEdgeRuntimeVersionPin } from "../../../shared/functions/functions.shared.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { GoProxy } from "../../../command-internal/go-proxy.service.ts";
import { aqua, bold, yellow } from "../../../command-internal/colors.ts";
import { functionsGoConfigCompat } from "../../../command-internal/functions-go-config.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { FunctionsDownloadFlags } from "./download.command.ts";

export const functionsDownload = Effect.fn("functions.download")(function* (
  flags: FunctionsDownloadFlags,
) {
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const proxy = yield* GoProxy;
  const output = yield* Output;
  const stdio = yield* Stdio.Stdio;
  const rawArgs = yield* stdio.args;
  const edgeRuntimeVersion = yield* resolveEdgeRuntimeVersionPin(
    join(cliSettings.workdir, "supabase"),
  );
  let resolvedProjectRef = Option.none<string>();

  yield* Effect.gen(function* () {
    const result = yield* downloadFunctions(flags, {
      api,
      projectRoot: cliSettings.workdir,
      rawArgs,
      goConfigCompat: functionsGoConfigCompat,
      edgeRuntimeVersion,
      // Established styling: bold on the `Downloading function:` slug
      // (stderr) — matches `bold`'s default TTY gate.
      styleEmphasis: (text) => bold(text),
      // Established styling: aqua on the suggested `--legacy-bundle` command
      // (stderr) — matches `aqua`'s default TTY gate.
      styleAqua: (text) => aqua(text),
      // Established styling: yellow on the `WARNING:` token before "Docker is
      // not running" (stderr) — matches `yellow`'s default TTY gate.
      styleWarning: (text) => yellow(text),
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
      // `withCommandTelemetry` wrapper. Suppress it so proxied
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
    });

    // `--legacy-bundle` emits its own final summary inside `downloadFunctions`
    // (untouched by this refactor) — nothing left to do here on that path.
    if (flags.legacyBundle) {
      return;
    }

    if (result.empty) {
      if (output.format === "text") {
        yield* output.raw(`No functions found in project  ${result.projectRef}\n`, "stderr");
        return;
      }
      yield* output.success("No functions found.", {
        function_slugs: [],
        project_ref: result.projectRef,
      });
      return;
    }

    if (output.format !== "text") {
      yield* output.success("Downloaded Edge Function source.", {
        function_slugs: result.slugs,
        project_ref: result.projectRef,
      });
      return;
    }

    if (Option.isNone(flags.functionName)) {
      yield* output.raw(
        `Successfully downloaded all functions from project ${result.projectRef}\n`,
        "stderr",
      );
    }
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
