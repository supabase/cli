import { Effect, type Option } from "effect";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyWorkersProjectRefSuffix } from "./workers.output.ts";

export interface LegacyWorkersRunContext {
  readonly projectRef: string;
  /** What a suggestion must carry — see `legacyWorkersProjectRefSuffix`. */
  readonly refSuffix: string;
}

/**
 * The lifecycle every project-scoped workers command shares.
 *
 * The ordering is the point: telemetry wraps the ref resolution, since an
 * unlinked checkout fails inside `resolve` once the command has already run.
 * The linked-project cache stays under the ref, having nothing to write without
 * one.
 */
export const legacyWorkersRun = <A, E, R>(
  projectRefFlag: Option.Option<string>,
  body: (context: LegacyWorkersRunContext) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const resolver = yield* LegacyProjectRefResolver;
    const linkedProjectCache = yield* LegacyLinkedProjectCache;
    const telemetryState = yield* LegacyTelemetryState;

    return yield* Effect.gen(function* () {
      const projectRef = yield* resolver.resolve(projectRefFlag);
      return yield* body({
        projectRef,
        refSuffix: legacyWorkersProjectRefSuffix(projectRefFlag),
      }).pipe(Effect.ensuring(linkedProjectCache.cache(projectRef)));
    }).pipe(Effect.ensuring(telemetryState.flush));
  });
