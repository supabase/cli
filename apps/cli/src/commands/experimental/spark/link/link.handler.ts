import { DateTime, Effect, Option } from "effect";

import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../../config/project-ref.service.ts";
import { writeProjectLink } from "../../../../shared/config/project-link.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LinkedProjectCache } from "../../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { getSparkProject } from "../spark-api.ts";

/** `supabase link`: checks the project exists, then records it in `supabase/.link.json`. */
export const sparkLink = Effect.fn("spark.link")(function* (flags: {
  readonly projectRef: Option.Option<string>;
}) {
  const resolver = yield* ProjectRefResolver;
  const settings = yield* CommandSettings;
  const output = yield* Output;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const ref = yield* resolver.resolveForLink(flags.projectRef);
  yield* Effect.gen(function* () {
    const project = yield* getSparkProject(ref);
    yield* writeProjectLink(settings.workdir, {
      project: {
        ref,
        ...(project.name === undefined ? {} : { name: project.name }),
        ...(project.organization_id === undefined
          ? {}
          : { organization_id: project.organization_id }),
        ...(project.organization_slug === undefined
          ? {}
          : { organization_slug: project.organization_slug }),
      },
      active_branch: { ref, ...(project.name === undefined ? {} : { name: project.name }) },
      fetchedAt: DateTime.formatIso(yield* DateTime.now),
    });
    yield* output.raw("Finished supabase link.\n");
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
