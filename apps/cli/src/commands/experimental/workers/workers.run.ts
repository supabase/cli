import { Effect, type Option } from "effect";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { workersProjectRefSuffix } from "./workers.output.ts";

export interface WorkersRunContext {
  readonly projectRef: string;
  /** What a suggestion must carry — see `workersProjectRefSuffix`. */
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
export const workersRun = <A, E, R>(
  projectRefFlag: Option.Option<string>,
  body: (context: WorkersRunContext) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const resolver = yield* ProjectRefResolver;
    const linkedProjectCache = yield* LinkedProjectCache;
    const telemetryState = yield* TelemetryState;

    return yield* Effect.gen(function* () {
      const projectRef = yield* resolver.resolve(projectRefFlag);
      return yield* body({
        projectRef,
        refSuffix: workersProjectRefSuffix(projectRefFlag),
      }).pipe(Effect.ensuring(linkedProjectCache.cache(projectRef)));
    }).pipe(Effect.ensuring(telemetryState.flush));
  });
