import { join } from "node:path";
import { Effect, Option, Stdio } from "effect";
import { downloadFunctions } from "../../../shared/functions/download.ts";
import { resolveEdgeRuntimeVersionPin } from "../../../shared/functions/functions.shared.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { aqua, bold, yellow } from "../../../command-internal/colors.ts";
import { functionsGoConfigCompat } from "../../../command-internal/functions-go-config.ts";
import { removedFlag } from "../../../command-internal/removed-command.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { FunctionsDownloadFlags } from "./download.command.ts";

export const functionsDownload = Effect.fn("functions.download")(function* (
  flags: FunctionsDownloadFlags,
) {
  if (flags.legacyBundle) {
    return yield* removedFlag(
      "--legacy-bundle",
      "Retry with `supabase functions download --use-api <slug>` to unbundle server-side without Docker.",
    );
  }
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
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
      // Written to stderr, matching `bold`'s default TTY gate.
      styleEmphasis: (text) => bold(text),
      // Written to stderr, matching `aqua`'s default TTY gate.
      styleAqua: (text) => aqua(text),
      // Written to stderr, matching `yellow`'s default TTY gate.
      styleWarning: (text) => yellow(text),
      resolveProjectRef: (projectRef) =>
        resolver.resolve(projectRef).pipe(
          Effect.tap((ref) =>
            Effect.sync(() => {
              resolvedProjectRef = Option.some(ref);
            }),
          ),
        ),
    });

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
