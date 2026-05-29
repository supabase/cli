import type { V1ListAllProjectsOutput } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { encodeGoJson, encodeToml, encodeYaml } from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyProjectsEnvNotSupportedError,
  LegacyProjectsListNetworkError,
  LegacyProjectsListUnexpectedStatusError,
} from "../projects.errors.ts";
import { type LegacyLinkedProject, renderProjectsListTable } from "../projects.format.ts";
import type { LegacyProjectsListFlags } from "./list.command.ts";

type Projects = typeof V1ListAllProjectsOutput.Type;

const mapListError = mapLegacyHttpError({
  networkError: LegacyProjectsListNetworkError,
  statusError: LegacyProjectsListUnexpectedStatusError,
  networkMessage: (cause) => `failed to list projects: ${cause}`,
  statusMessage: (_status, body) => `Unexpected error retrieving projects: ${body}`,
});

export const legacyProjectsList = Effect.fn("legacy.projects.list")(function* (
  _flags: LegacyProjectsListFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  // Go's `list.go:31-33` loads the linked ref purely as a marker — `ErrNotLinked`
  // is ignored, no prompt fires. `resolveOptional` never fails or prompts.
  const linkedRef = yield* resolver.resolveOptional(Option.none());

  yield* Effect.gen(function* () {
    const fetching =
      output.format === "text" ? yield* output.task("Fetching projects...") : undefined;
    const response: Projects = yield* api.v1.listAllProjects().pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.catch(mapListError),
    );
    yield* fetching?.clear() ?? Effect.void;

    const projects: ReadonlyArray<LegacyLinkedProject> = response.map((project) => ({
      ...project,
      linked: Option.isSome(linkedRef) && linkedRef.value === project.id,
    }));

    const goFmt = Option.getOrUndefined(goOutputFlag);

    if (goFmt === "env") {
      return yield* new LegacyProjectsEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    if (goFmt === "json") {
      yield* output.raw(encodeGoJson(projects));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeYaml(projects));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw(encodeToml({ projects }) + "\n");
      return;
    }

    // goFmt is undefined or "pretty" — defer to TS --output-format for
    // JSON/stream-json, otherwise render the Glamour-styled table.
    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", { projects });
      return;
    }

    yield* output.raw(renderProjectsListTable(projects));
  }).pipe(
    // Cache the linked ref only when one actually resolved (Go caches via
    // PersistentPostRun off `flags.ProjectRef`, which stays empty when unlinked).
    Effect.ensuring(
      Option.isSome(linkedRef) ? linkedProjectCache.cache(linkedRef.value) : Effect.void,
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
