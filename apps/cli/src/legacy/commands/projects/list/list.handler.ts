import { operationDefinitions } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { encodeGoJson } from "../../../shared/legacy-go-output.encoders.ts";
import {
  type LegacyGoType,
  encodeLegacyGoToml,
  encodeLegacyGoYaml,
  legacyGoBool,
  legacyGoSlice,
  legacyGoString,
  legacyGoStruct,
  legacyGoTomlListWrapper,
} from "../../../shared/legacy-go-struct-output.encoders.ts";
import { sanitizeLegacyErrorBody } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyProjectsEnvNotSupportedError,
  LegacyProjectsListNetworkError,
  LegacyProjectsListUnexpectedStatusError,
} from "../projects.errors.ts";
import {
  type LegacyLinkedProject,
  readProjectField,
  renderProjectsListTable,
} from "../projects.format.ts";
import type { LegacyProjectsListFlags } from "./list.command.ts";

/**
 * Struct spec for the linked-project projection: an embedded project
 * response (fields inlined first, in declaration order) plus the
 * CLI-added `Linked bool`.
 */
const LEGACY_GO_LINKED_PROJECT: LegacyGoType = legacyGoStruct([
  ["created_at", legacyGoString],
  [
    "database",
    legacyGoStruct([
      ["host", legacyGoString],
      ["postgres_engine", legacyGoString],
      ["release_channel", legacyGoString],
      ["version", legacyGoString],
    ]),
  ],
  ["id", legacyGoString],
  ["name", legacyGoString],
  ["organization_id", legacyGoString],
  ["organization_slug", legacyGoString],
  ["ref", legacyGoString],
  ["region", legacyGoString],
  ["status", legacyGoString],
  ["linked", legacyGoBool],
]);

const LEGACY_GO_PROJECTS_LIST = legacyGoSlice(LEGACY_GO_LINKED_PROJECT);

const LEGACY_GO_PROJECTS_TOML_WRAPPER = legacyGoTomlListWrapper(
  "projects",
  LEGACY_GO_LINKED_PROJECT,
);

export const legacyProjectsList = Effect.fn("legacy.projects.list")(function* (
  _flags: LegacyProjectsListFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  // The linked ref is loaded purely as a marker — a not-linked error is
  // ignored, no prompt fires. `resolveOptional` never fails or prompts.
  const linkedRef = yield* resolver.resolveOptional(Option.none());

  yield* Effect.gen(function* () {
    const fetching =
      output.format === "text" ? yield* output.task("Fetching projects...") : undefined;

    // `executeRaw` returns the undecoded response: the generated
    // `V1ProjectWithDatabaseResponse.ref` schema enforces `isMinLength(20)` +
    // `^[a-z]+$`, which the cli-e2e replay fixtures (literal `__PROJECT_REF__`)
    // cannot satisfy. Auth / URL / headers are still handled by the API client.
    const response = yield* api.executeRaw(operationDefinitions.v1ListAllProjects, {}).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.mapError(
        (cause) =>
          new LegacyProjectsListNetworkError({ message: `failed to list projects: ${cause}` }),
      ),
    );

    if (response.status !== 200) {
      const body = sanitizeLegacyErrorBody(
        yield* response.text.pipe(Effect.orElseSucceed(() => "")),
      );
      yield* fetching?.fail() ?? Effect.void;
      return yield* new LegacyProjectsListUnexpectedStatusError({
        status: response.status,
        body,
        message: `Unexpected error retrieving projects: ${body}`,
      });
    }

    const parsed = yield* response.json.pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.mapError(
        (cause) =>
          new LegacyProjectsListUnexpectedStatusError({
            status: response.status,
            body: "",
            message: `Unexpected error retrieving projects: ${cause}`,
            decode: true,
          }),
      ),
    );
    if (!Array.isArray(parsed)) {
      yield* fetching?.fail() ?? Effect.void;
      return yield* new LegacyProjectsListUnexpectedStatusError({
        status: response.status,
        body: "",
        message: "Unexpected error retrieving projects: response was not an array",
        decode: true,
      });
    }
    yield* fetching?.clear() ?? Effect.void;

    // Established behavior: prints the not-linked message to stderr when no
    // ref resolves, then renders the table anyway. "supabase link" is
    // colored via `Aqua` — plain on a non-TTY — and uses no backticks,
    // unlike the resolver's hard-fail message.
    if (Option.isNone(linkedRef)) {
      yield* output.raw("Cannot find project ref. Have you run supabase link?\n", "stderr");
    }

    const projects: ReadonlyArray<LegacyLinkedProject> = parsed.map((project) => ({
      ...(typeof project === "object" && project !== null ? project : {}),
      linked: Option.isSome(linkedRef) && readProjectField(project, "id") === linkedRef.value,
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
      yield* output.raw(encodeLegacyGoYaml(projects, LEGACY_GO_PROJECTS_LIST));
      return;
    }
    if (goFmt === "toml") {
      // The list is built with `append`, so an empty list stays a nil slice
      // and BurntSushi emits nothing for the wrapper.
      yield* output.raw(
        encodeLegacyGoToml(
          { projects: projects.length > 0 ? projects : undefined },
          LEGACY_GO_PROJECTS_TOML_WRAPPER,
        ),
      );
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
    Effect.ensuring(
      Option.isSome(linkedRef) ? linkedProjectCache.cache(linkedRef.value) : Effect.void,
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
