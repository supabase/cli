import { Effect, Option, Ref } from "effect";
import { deleteFunction } from "../../../shared/functions/delete.ts";
import { aqua } from "../../../command-internal/colors.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { resolveProjectTarget } from "../../../command-internal/target/resolve-project-target.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { FunctionsDeleteFlags } from "./delete.command.ts";

export const functionsDelete = Effect.fn("functions.delete")(function* (
  flags: FunctionsDeleteFlags,
) {
  const api = yield* CommandPlatformApi;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const resolvedProjectRef = yield* Ref.make(Option.none<string>());

  yield* deleteFunction(
    { slug: flags.functionName },
    {
      api,
      resolveProjectRef: resolveProjectTarget(flags).pipe(
        Effect.tap((ref) => Ref.set(resolvedProjectRef, Option.some(ref))),
      ),
      // The "Deleted Function" line is stdout-bound, so the TTY gate must check stdout.
      styleIdentifier: (text) => aqua(text, process.stdout),
    },
  ).pipe(
    Effect.ensuring(
      Ref.get(resolvedProjectRef).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (ref) =>
              Effect.annotateCurrentSpan("project.ref", ref).pipe(
                Effect.andThen(linkedProjectCache.cache(ref)),
              ),
          }),
        ),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
