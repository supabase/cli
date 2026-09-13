import { operationDefinitions } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { encodeGoJson } from "../../../command-internal/go-output.encoders.ts";
import { resolveLinkedParentRef } from "../../../command-internal/parent-project-ref.ts";
import {
  type GoType,
  encodeGoToml,
  encodeGoYaml,
  goBool,
  goSlice,
  goString,
  goStruct,
  goTomlListWrapper,
} from "../../../command-internal/go-struct-output.encoders.ts";
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
const GO_LINKED_PROJECT: GoType = goStruct([
  ["created_at", goString],
  [
    "database",
    goStruct([
      ["host", goString],
      ["postgres_engine", goString],
      ["release_channel", goString],
      ["version", goString],
    ]),
  ],
  ["id", goString],
  ["name", goString],
  ["organization_id", goString],
  ["organization_slug", goString],
  ["ref", goString],
  ["region", goString],
  ["status", goString],
  ["linked", goBool],
]);

const GO_PROJECTS_LIST = goSlice(GO_LINKED_PROJECT);

const GO_PROJECTS_TOML_WRAPPER = goTomlListWrapper("projects", GO_LINKED_PROJECT);

export const projectsList = Effect.fn("projects.list")(function* (_flags: ProjectsListFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
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
    yield* fetching?.clear() ?? Effect.void;

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

    const goFmt = Option.getOrUndefined(goOutputFlag);

    if (goFmt === "env") {
      return yield* new ProjectsEnvNotSupportedError({
        message: "--output env flag is not supported",
      });
    }
    if (goFmt === "json") {
      yield* output.raw(encodeGoJson(projects));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeGoYaml(projects, GO_PROJECTS_LIST));
      return;
    }
    if (goFmt === "toml") {
      // Passing `undefined` (not an empty array) omits the wrapper entirely when there are no
      // projects.
      yield* output.raw(
        encodeGoToml(
          { projects: projects.length > 0 ? projects : undefined },
          GO_PROJECTS_TOML_WRAPPER,
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
