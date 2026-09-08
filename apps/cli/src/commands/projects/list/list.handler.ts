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

    // Established behavior: prints the not-linked message to stderr when no
    // ref resolves, then renders the table anyway. "supabase link" is
    // colored via `Aqua` — plain on a non-TTY — and uses no backticks,
    // unlike the resolver's hard-fail message.
    if (Option.isNone(linkedRef)) {
      yield* output.raw("Cannot find project ref. Have you run supabase link?\n", "stderr");
    }

    // CLI-2167 follow-up: after `link <branch>`, `linkedRef` is the BRANCH's
    // own ref, which never matches a row here (this endpoint only returns
    // real projects), so the "you are here" marker silently vanished. An
    // exact match always wins outright; only when it misses do we fall back
    // to the PARENT chain (env → `linked-project.json` → `project-ref` file)
    // and mark that ref's row instead. `linkedRef` itself (used below for the
    // stderr message and the linked-project-cache write) is untouched — only
    // the marker comparison changes. TS-only QoL, no Go counterpart.
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
      // The list is built with `append`, so an empty list stays a nil slice
      // and BurntSushi emits nothing for the wrapper.
      yield* output.raw(
        encodeGoToml(
          { projects: projects.length > 0 ? projects : undefined },
          GO_PROJECTS_TOML_WRAPPER,
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
