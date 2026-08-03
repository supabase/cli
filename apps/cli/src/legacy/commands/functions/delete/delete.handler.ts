import { Effect, Option } from "effect";
import { deleteFunction } from "../../../../shared/functions/delete.ts";
import { legacyAqua } from "../../../shared/legacy-colors.ts";
import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import type { LegacyFunctionsDeleteFlags } from "./delete.command.ts";

export const legacyFunctionsDelete = Effect.fn("legacy.functions.delete")(function* (
  flags: LegacyFunctionsDeleteFlags,
) {
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
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
      styleIdentifier: (text) => legacyAqua(text, process.stdout),
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
