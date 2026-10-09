import { operationDefinitions } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeSortedJson } from "../../../command-internal/output.encoders.ts";
import { resolveLinkedParentRef } from "../../../command-internal/parent-project-ref.ts";
import {
  type OutputShape,
  encodeStructToml,
  encodeStructYaml,
  shapeBool,
  shapeSlice,
  shapeString,
  shapeStruct,
  shapeTomlListWrapper,
} from "../../../command-internal/struct-output.encoders.ts";
import { sanitizeErrorBody } from "../../../command-internal/http-errors.ts";
import {
  ProjectsEnvNotSupportedError,
  ProjectsListNetworkError,
  ProjectsListUnexpectedStatusError,
} from "../projects.errors.ts";
import {
  type LinkedProject,
  readProjectField,
  renderProjectsListTable,
} from "../projects.format.ts";
import type { ProjectsListFlags } from "./list.command.ts";

/**
 * Struct spec for the linked-project projection: an embedded project
 * response (fields inlined first, in declaration order) plus the
 * CLI-added `Linked bool`.
 */
const LINKED_PROJECT_SHAPE: OutputShape = shapeStruct([
  ["created_at", shapeString],
  [
    "database",
    shapeStruct([
      ["host", shapeString],
      ["postgres_engine", shapeString],
      ["release_channel", shapeString],
      ["version", shapeString],
    ]),
  ],
  ["id", shapeString],
  ["name", shapeString],
  ["organization_id", shapeString],
  ["organization_slug", shapeString],
  ["ref", shapeString],
  ["region", shapeString],
  ["status", shapeString],
  ["linked", shapeBool],
]);

const PROJECTS_LIST_SHAPE = shapeSlice(LINKED_PROJECT_SHAPE);

const PROJECTS_TOML_WRAPPER_SHAPE = shapeTomlListWrapper("projects", LINKED_PROJECT_SHAPE);

export const projectsList = Effect.fn("projects.list")(function* (_flags: ProjectsListFlags) {
  const output = yield* Output;
  const outputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;

  // Loaded purely as a marker for the "linked" column; `resolveOptional` never fails or prompts.
  const linkedRef = yield* resolver.resolveOptional(Option.none());

  yield* Effect.gen(function* () {
    const fetching =
      output.format === "text" ? yield* output.task("Fetching projects...") : undefined;

    // `executeRaw` skips response decoding: the generated `ref` schema requires 20+ lowercase
    // letters, which placeholder refs in test fixtures don't satisfy. Auth, URL, and headers
    // still go through the API client.
    const response = yield* api.executeRaw(operationDefinitions.v1ListAllProjects, {}).pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.mapError(
        (cause) => new ProjectsListNetworkError({ message: `failed to list projects: ${cause}` }),
      ),
    );

    if (response.status !== 200) {
      const body = sanitizeErrorBody(yield* response.text.pipe(Effect.orElseSucceed(() => "")));
      yield* fetching?.fail() ?? Effect.void;
      return yield* new ProjectsListUnexpectedStatusError({
        status: response.status,
        body,
        message: `Unexpected error retrieving projects: ${body}`,
      });
    }

    const parsed = yield* response.json.pipe(
      Effect.tapError(() => fetching?.fail() ?? Effect.void),
      Effect.mapError(
        (cause) =>
          new ProjectsListUnexpectedStatusError({
            status: response.status,
            body: "",
            message: `Unexpected error retrieving projects: ${cause}`,
            decode: true,
          }),
      ),
    );
    if (!Array.isArray(parsed)) {
      yield* fetching?.fail() ?? Effect.void;
      return yield* new ProjectsListUnexpectedStatusError({
        status: response.status,
        body: "",
        message: "Unexpected error retrieving projects: response was not an array",
        decode: true,
      });
    }
    yield* fetching?.clear ?? Effect.void;

    // Prints the not-linked message to stderr but still renders the table below.
    if (Option.isNone(linkedRef)) {
      yield* output.raw("Cannot find project ref. Have you run supabase link?\n", "stderr");
    }

    // `markerRef` decides which row shows as linked, since a linked branch's own ref never
    // matches a project row here. An exact match on `linkedRef` wins outright; only when it
    // misses do we fall back to the parent chain (env → linked-project.json → project-ref file).
    let markerRef = linkedRef;
    if (Option.isSome(linkedRef)) {
      const hasExactMatch = parsed.some(
        (project) => readProjectField(project, "id") === linkedRef.value,
      );
      if (!hasExactMatch) {
        const parent = yield* resolveLinkedParentRef();
        markerRef = parent.kind === "resolved" ? Option.some(parent.ref) : Option.none();
      }
    }

    const projects: ReadonlyArray<LinkedProject> = parsed.map((project) => ({
      ...(typeof project === "object" && project !== null ? project : {}),
      linked: Option.isSome(markerRef) && readProjectField(project, "id") === markerRef.value,
    }));

    const outputFlagFormat = Option.getOrUndefined(outputFlag);

    if (outputFlagFormat === "env") {
      return yield* new ProjectsEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    if (outputFlagFormat === "json") {
      yield* output.raw(encodeSortedJson(projects));
      return;
    }
    if (outputFlagFormat === "yaml") {
      yield* output.raw(encodeStructYaml(projects, PROJECTS_LIST_SHAPE));
      return;
    }
    if (outputFlagFormat === "toml") {
      // Passing `undefined` (not an empty array) omits the wrapper entirely when there are no
      // projects.
      yield* output.raw(
        encodeStructToml(
          { projects: projects.length > 0 ? projects : undefined },
          PROJECTS_TOML_WRAPPER_SHAPE,
        ),
      );
      return;
    }

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
