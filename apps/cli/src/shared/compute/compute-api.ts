import {
  operationDefinitions,
  V2CreateComputeInstanceUploadOutput,
  V2DeployAComputeInstanceOutput,
  V2GetAComputeInstanceOutput,
  V2ListAllComputeInstancesOutput,
  type ApiClient,
} from "@supabase/api/effect";
import { Effect, Option, Schedule, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { decodeBody, mapRequestError, unexpectedStatus } from "./compute-api-status.ts";
import {
  ComputeBuildTimeoutError,
  ComputeProjectNotFoundError,
  ComputeRouteNotFoundError,
  ComputeUnavailableError,
  ComputeUploadFailedError,
} from "./compute.errors.ts";

/**
 * The seam every compute command talks to: `/v2/projects/{ref}/compute` on the Management API. A
 * 404 here is overloaded — a project outside the alpha's allow-list, an unknown project ref, an
 * undeployed compute, and a route the API has since renamed all answer the same way. A
 * named-compute 404 is reported as "not deployed" unless the body is the router's, which no
 * compute name can explain; a collection-endpoint 404, where no name could be wrong either way,
 * is split by its body instead — see {@link projectScoped404}.
 */

/** The compute shape the API returns, flattened out of its JSON:API envelope. */
export interface ComputeRecord {
  readonly name: string;
  readonly spec: {
    readonly runtime?: string;
    readonly size: string;
    readonly exposure: string;
    readonly instances: number;
    readonly backend?: string;
  };
  readonly buildState: "building" | "active" | "failed";
  readonly stateReason?: string;
  readonly imageVersion?: string;
  readonly deleting?: boolean;
  /** Present only on single-compute reads; a fresh deploy has nothing to report yet. */
  readonly instances?: {
    readonly declared: number;
    readonly live: number;
    readonly ready: number;
    readonly stale: number;
  };
  /** Set instead of `instances` when the instance read-through failed. */
  readonly instancesError?: string;
}

export interface ComputeUploadSlot {
  readonly uploadId: string;
  readonly url: string;
  readonly method: string;
  readonly expiresAt: string;
}

/** The `spec` a deploy sends. Mirrors the API's own field names exactly. */
export interface ComputeDeploySpec {
  readonly runtime?: string;
  readonly size: string;
  readonly exposure: string;
  readonly instances: number;
}

type ComputeResourceData = typeof V2GetAComputeInstanceOutput.Type extends { data: infer D }
  ? D
  : never;

function toComputeRecord(data: ComputeResourceData): ComputeRecord {
  return {
    name: data.id,
    spec: data.attributes.spec,
    buildState: data.attributes.build_state,
    stateReason: data.attributes.state_reason,
    imageVersion: data.attributes.image_version,
    deleting: data.attributes.deleting,
    instances: data.attributes.instances,
    instancesError: data.attributes.instances_error,
  };
}

const computeSuggestion =
  "Compute is in private alpha. Ask in the Supabase dashboard to have this project enrolled.";

/**
 * The `error.code` a 404 carries, and the `message` needed where the code alone is ambiguous.
 * Three unrelated failures answer 404 on these routes:
 *
 * - not enrolled -> `{"error":{"code":"not_found.compute.not_enabled","message":"Compute is not available for this project"}}`
 * - no such project -> `{"error":{"code":"not_found","message":"Not Found"}}`
 * - no such route -> `{"error":{"code":"not_found","message":"Cannot GET /v2/projects/{ref}/compute"}}`
 *
 * The last two share a code, so the message is the only thing separating them.
 */
const NotFoundBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    // Unknown rather than String: a non-string message must not fail the decode and cost the
    // code-based classification the rest of this reads.
    message: Schema.optionalKey(Schema.Unknown),
  }),
});

/**
 * The router's own 404 text rather than the project handler's: the API answers an unrouted path
 * with Express's default `Cannot <METHOD> <path>`. Anchored so a detail merely containing the
 * phrase cannot match.
 *
 * The router's 404 carries no code of its own, so unlike the other two this one can only be read
 * from the message.
 */
const ROUTE_NOT_FOUND_MESSAGE = /^Cannot [A-Z]+ \//;

/**
 * Compute is an allow-listed alpha, so a route the API does not serve is nobody's to fix locally:
 * neither a newer CLI nor enrolment puts the route back. Reporting it is the only move.
 */
const unservedRouteSuggestion = "Report it with `supabase issue`, including the route named above.";

const parse404 = (body: string) =>
  Schema.decodeEffect(Schema.fromJsonString(NotFoundBody))(body).pipe(Effect.option);

/** The route the router's own text names, when the body is that rather than a handler's. */
const unroutedPath = (
  parsed: Option.Option<Schema.Schema.Type<typeof NotFoundBody>>,
): Option.Option<string> => {
  if (Option.isNone(parsed) || parsed.value.error.code !== "not_found") return Option.none();
  const { message } = parsed.value.error;
  // `Cannot GET /v2/projects/{ref}/compute` -> `GET /v2/projects/{ref}/compute`
  return typeof message === "string" && ROUTE_NOT_FOUND_MESSAGE.test(message)
    ? Option.some(message.slice("Cannot ".length))
    : Option.none();
};

const routeNotFound = (projectRef: string, route: string) =>
  new ComputeRouteNotFoundError({
    detail: `The Management API does not serve ${route}, so this CLI cannot reach compute for project ${projectRef}.`,
    suggestion: unservedRouteSuggestion,
  });

/**
 * Which of the three a project-scoped 404 was. `not_found` carrying the router's message means
 * the API does not serve the route; `not_found` otherwise means the project is missing. Every
 * other body, including the enrolment refusal's own `not_found.compute.not_enabled`, answers
 * unavailable — the safe default, since guessing the other way would send someone to check a ref
 * that's actually fine.
 */
const projectScoped404 = Effect.fnUntraced(function* (options: {
  readonly projectRef: string;
  readonly body: string;
}) {
  const parsed = yield* parse404(options.body);
  const route = unroutedPath(parsed);

  if (Option.isSome(route)) return routeNotFound(options.projectRef, route.value);

  if (Option.isSome(parsed) && parsed.value.error.code === "not_found") {
    return new ComputeProjectNotFoundError({
      detail: `No project ${options.projectRef} was found for this account.`,
      suggestion:
        "Check the project ref, or pick the project again with `supabase link`. " +
        "If it belongs to another account, log in with `supabase login`.",
    });
  }

  return new ComputeUnavailableError({
    detail: `Compute is not available for project ${options.projectRef}.`,
    suggestion: computeSuggestion,
  });
});

/**
 * Fails when a named-compute 404 came from the router rather than from the compute being absent.
 * Those routes read their own 404 as "not deployed", which is the right answer for every 404 but
 * this one: an unserved route would otherwise report a live compute as missing, and let `delete`
 * claim it removed something it never reached.
 */
const refuseUnroutedPath = Effect.fnUntraced(function* (options: {
  readonly projectRef: string;
  readonly body: string;
}) {
  const route = unroutedPath(yield* parse404(options.body));
  if (Option.isSome(route)) return yield* routeNotFound(options.projectRef, route.value);
});

export const listCompute = Effect.fnUntraced(function* (api: ApiClient, projectRef: string) {
  const operation = "list compute";
  const response = yield* api
    .executeRaw(operationDefinitions.v2ListAllComputeInstances, { ref: projectRef })
    .pipe(Effect.mapError(mapRequestError(operation)));

  if (response.status === 404) {
    const error = yield* projectScoped404({
      projectRef,
      body: yield* response.text.pipe(Effect.orElseSucceed(() => "")),
    });
    return yield* error;
  }
  if (response.status !== 200) {
    return yield* unexpectedStatus({
      operation,
      status: response.status,
      body: yield* response.text.pipe(Effect.orElseSucceed(() => "")),
    });
  }

  const body = yield* response.json.pipe(Effect.mapError(mapRequestError(operation)));
  const decoded = yield* decodeBody(
    V2ListAllComputeInstancesOutput,
    operation,
    body,
    response.status,
  );
  return decoded.data.map(toComputeRecord);
});

/**
 * One compute, or `None` when the API has no record of it — which is also what a
 * project outside the alpha's allow-list answers, so callers report it as "not
 * deployed" and point at `push` rather than guessing which of the two it was.
 */
export const getCompute = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  name: string,
) {
  const operation = `read compute "${name}"`;
  const response = yield* api
    .executeRaw(operationDefinitions.v2GetAComputeInstance, { ref: projectRef, name })
    .pipe(Effect.mapError(mapRequestError(operation)));

  if (response.status === 404) {
    yield* refuseUnroutedPath({
      projectRef,
      body: yield* response.text.pipe(Effect.orElseSucceed(() => "")),
    });
    return Option.none<ComputeRecord>();
  }
  if (response.status !== 200) {
    return yield* unexpectedStatus({
      operation,
      status: response.status,
      body: yield* response.text.pipe(Effect.orElseSucceed(() => "")),
    });
  }

  const body = yield* response.json.pipe(Effect.mapError(mapRequestError(operation)));
  const decoded = yield* decodeBody(V2GetAComputeInstanceOutput, operation, body, response.status);
  return Option.some(toComputeRecord(decoded.data));
});

export const createComputeUpload = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  name: string,
) {
  const operation = `stage a build context for "${name}"`;
  const response = yield* api
    .executeRaw(operationDefinitions.v2CreateComputeInstanceUpload, { ref: projectRef, name })
    .pipe(Effect.mapError(mapRequestError(operation)));

  if (response.status === 404) {
    const error = yield* projectScoped404({
      projectRef,
      body: yield* response.text.pipe(Effect.orElseSucceed(() => "")),
    });
    return yield* error;
  }
  if (response.status !== 201 && response.status !== 200) {
    return yield* unexpectedStatus({
      operation,
      status: response.status,
      body: yield* response.text.pipe(Effect.orElseSucceed(() => "")),
    });
  }

  const body = yield* response.json.pipe(Effect.mapError(mapRequestError(operation)));
  const decoded = yield* decodeBody(
    V2CreateComputeInstanceUploadOutput,
    operation,
    body,
    response.status,
  );
  return {
    uploadId: decoded.data.id,
    url: decoded.data.attributes.url,
    method: decoded.data.attributes.method,
    expiresAt: decoded.data.attributes.expires_at,
  } satisfies ComputeUploadSlot;
});

/**
 * PUTs the archive straight at the presigned slot, with no Supabase credentials attached — the
 * signature in the URL is the authorization. That's also why `httpClientLayer` redacts query
 * strings before logging: under `--debug` this URL is a write-capable credential.
 */
export const uploadBuildContext = Effect.fnUntraced(function* (
  slot: ComputeUploadSlot,
  archive: Uint8Array,
) {
  const client = yield* HttpClient.HttpClient;

  // The slot names its own method; anything other than `POST` falls back to `PUT`, the only
  // method documented for a presigned object-store destination.
  const request = (
    slot.method.toUpperCase() === "POST"
      ? HttpClientRequest.post(slot.url)
      : HttpClientRequest.put(slot.url)
  ).pipe(HttpClientRequest.bodyUint8Array(archive, "application/gzip"));

  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      (error) =>
        new ComputeUploadFailedError({
          // Deliberately not `error.message`, which is what the other transport
          // failures in this module use: it appends the URL that failed, and
          // here that URL is the write-capable signature. The reason's own
          // description is the part worth showing, and the destination is
          // already named by the step the user is watching.
          detail: `Uploading the build context failed: ${
            error.reason.description ?? "the upload request did not complete"
          }.`,
          suggestion: "Check your network connection, then re-run the same command.",
        }),
    ),
  );

  if (response.status < 200 || response.status >= 300) {
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* new ComputeUploadFailedError({
      detail: `Uploading the build context failed with status ${response.status}${
        body.trim() === "" ? "" : `: ${body.trim()}`
      }.`,
      suggestion: "Re-run the same command; the upload slot is minted fresh each time.",
    });
  }
});

export const deployCompute = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  name: string,
  attributes: { readonly spec: ComputeDeploySpec; readonly contextUploadId?: string },
) {
  const operation = `deploy compute "${name}"`;
  const response = yield* api
    .executeRaw(operationDefinitions.v2DeployAComputeInstance, {
      ref: projectRef,
      name,
      data: {
        type: "project_compute_instance",
        attributes: {
          spec: attributes.spec,
          ...(attributes.contextUploadId === undefined
            ? {}
            : { context_upload_id: attributes.contextUploadId }),
        },
      },
    })
    .pipe(Effect.mapError(mapRequestError(operation)));

  if (response.status === 404) {
    const error = yield* projectScoped404({
      projectRef,
      body: yield* response.text.pipe(Effect.orElseSucceed(() => "")),
    });
    return yield* error;
  }
  if (response.status !== 202 && response.status !== 200 && response.status !== 201) {
    return yield* unexpectedStatus({
      operation,
      status: response.status,
      body: yield* response.text.pipe(Effect.orElseSucceed(() => "")),
    });
  }

  const body = yield* response.json.pipe(Effect.mapError(mapRequestError(operation)));
  const decoded = yield* decodeBody(
    V2DeployAComputeInstanceOutput,
    operation,
    body,
    response.status,
  );
  return toComputeRecord(decoded.data);
});

export const deleteCompute = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  name: string,
) {
  const operation = `delete compute "${name}"`;
  const response = yield* api
    .executeRaw(operationDefinitions.v2DeleteAComputeInstance, { ref: projectRef, name })
    .pipe(Effect.mapError(mapRequestError(operation)));

  // 404 is the caller's own "not deployed" verdict to report; a delete that
  // races another one is still a delete that happened.
  if (response.status === 404) {
    return yield* refuseUnroutedPath({
      projectRef,
      body: yield* response.text.pipe(Effect.orElseSucceed(() => "")),
    });
  }
  if (response.status === 204 || response.status === 200) {
    return;
  }

  return yield* unexpectedStatus({
    operation,
    status: response.status,
    body: yield* response.text.pipe(Effect.orElseSucceed(() => "")),
  });
});

/**
 * The build runs asynchronously — deploy answers 202 and the compute reaches `active` or `failed`
 * later — so `push` polls `get` until `build_state` leaves `building`. Overridable so tests can
 * drive the loop without waiting on wall-clock delays.
 */
const COMPUTE_BUILD_POLL_SCHEDULE = Schedule.spaced("2 seconds").pipe(
  Schedule.upTo({ duration: "10 minutes" }),
);

/**
 * How long one poll read may keep failing before the deploy is called off. Bounded by elapsed
 * time rather than attempts, so a brief network blip can't exhaust the retries and abandon a
 * build the server is still running.
 */
const COMPUTE_POLL_READ_RETRY = Schedule.spaced("2 seconds").pipe(
  Schedule.upTo({ duration: "30 seconds" }),
);

export const awaitComputeBuild = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  name: string,
  options: {
    readonly schedule?: Schedule.Schedule<unknown>;
    /** Retry schedule for one poll read; overridable so a test can exercise the transient-failure path without a real clock. */
    readonly retrySchedule?: Schedule.Schedule<unknown>;
    /** Called with each poll's result, for progress reporting. */
    readonly onPoll?: (compute: ComputeRecord) => Effect.Effect<void>;
    /**
     * ` --project-ref <ref>` to append to the suggestion below, when the caller reached this
     * project via the flag rather than a link. The suggestion is copied verbatim, so omitting it
     * would re-resolve against whatever this checkout happens to be linked to.
     */
    readonly refSuffix?: string;
  } = {},
) {
  const poll = Effect.gen(function* () {
    // A build can run for minutes, so a single blip on one read should not throw
    // away a deploy that is progressing fine.
    const compute = yield* getCompute(api, projectRef, name).pipe(
      Effect.retry({ schedule: options.retrySchedule ?? COMPUTE_POLL_READ_RETRY }),
    );
    if (Option.isNone(compute)) {
      // The deploy was accepted, so the compute exists; a 404 here is the read
      // racing the write. Report it as still building and poll again.
      return undefined;
    }
    if (options.onPoll !== undefined) {
      yield* options.onPoll(compute.value);
    }
    return compute.value.buildState === "building" ? undefined : compute.value;
  });

  const settled = yield* poll.pipe(
    Effect.repeat({
      schedule: options.schedule ?? COMPUTE_BUILD_POLL_SCHEDULE,
      until: (result) => result !== undefined,
    }),
  );

  if (settled === undefined) {
    return yield* new ComputeBuildTimeoutError({
      detail: `"${name}" was still building when this command stopped waiting.`,
      suggestion: `Check on it with \`supabase compute status ${name}${options.refSuffix ?? ""}\`.`,
    });
  }

  return settled;
});
