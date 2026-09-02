import { Effect, type Option } from "effect";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyWorkersProjectRefSuffix } from "./workers.output.ts";

/** What every project-scoped workers command needs before it can do anything. */
export interface LegacyWorkersRunContext {
  readonly projectRef: string;
  /** The `--project-ref` a suggestion must carry, or `""` — see the helper. */
  readonly refSuffix: string;
}

/**
 * The lifecycle every project-scoped workers command shares.
 *
 * Telemetry wraps the ref resolution as well, because an unlinked
 * non-interactive checkout fails inside `resolve` and the command has run by
 * then. The linked-project cache stays under the ref, having nothing to write
 * without one.
 *
 * A helper rather than a per-command preamble because the ordering is the whole
 * point and is easy to get subtly wrong: four commands had the resolution above
 * both finalizers and silently wrote no post-run event.
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
