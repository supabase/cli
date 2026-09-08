import { Effect, Option } from "effect";
import { deleteFunction } from "../../../shared/functions/delete.ts";
import { aqua } from "../../../command-internal/colors.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { FunctionsDeleteFlags } from "./delete.command.ts";

export const functionsDelete = Effect.fn("functions.delete")(function* (
  flags: FunctionsDeleteFlags,
) {
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  let resolvedProjectRef = Option.none<string>();

  yield* deleteFunction(
    { slug: flags.functionName, projectRef: flags.projectRef },
    {
      api,
      resolveProjectRef: (projectRef) =>
        resolver.resolve(projectRef).pipe(
          Effect.tap((ref) =>
            Effect.sync(() => {
              resolvedProjectRef = Option.some(ref);
            }),
          ),
        ),
      // Go: `fmt.Printf("Deleted Function %s from project %s.\n", utils.Aqua(slug),
      // utils.Aqua(projectRef))` (`internal/functions/delete/delete.go:20`) —
      // stdout-bound, so the TTY gate must check stdout.
      styleIdentifier: (text) => aqua(text, process.stdout),
    },
  ).pipe(
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
