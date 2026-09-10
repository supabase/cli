import {
  operationDefinitions,
  V2CreateWorkerUploadOutput,
  V2DeployAWorkerOutput,
  V2GetAWorkerOutput,
  V2ListAllWorkersOutput,
  type ApiClient,
} from "@supabase/api/effect";
import { Effect, Option, Schedule, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { decodeBody, mapRequestError, unexpectedStatus } from "./compute-api-status.ts";
import {
  ComputeBuildTimeoutError,
  ComputeProjectNotFoundError,
  ComputeUnavailableError,
  ComputeUploadFailedError,
} from "./compute.errors.ts";

/**
 * The seam every compute command talks to: `/v2/projects/{ref}/workers` on the Management API. A
 * 404 here is overloaded — a project outside the alpha's allow-list, an unknown project ref, and
 * an undeployed compute all answer the same way. A named-compute 404 is reported as "not deployed";
 * a collection-endpoint 404, where no compute name could be wrong, is split by its body instead —
 * see {@link projectScoped404}.
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

type ComputeResourceData = typeof V2GetAWorkerOutput.Type extends { data: infer D } ? D : never;

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
 * The `error.code` a 404 carries — the only way to tell an unenrolled project from one that
 * doesn't exist, since both answer 404 on the same routes:
 *
 * - not enrolled -> `{"error":{"code":"generic_not_found","message":"Workers are not available for this project"}}`
 * - no such project -> `{"error":{"code":"not_found","message":"Not Found"}}`
 */
const NotFoundBody = Schema.Struct({
  error: Schema.Struct({ code: Schema.String }),
});

/**
 * Which of the two a project-scoped 404 was. Only `not_found` is read as a missing project — an
 * unrecognized body defaults to the enrolment answer, since guessing the other way would send
 * someone to check a ref that's actually fine.
 */
const projectScoped404 = Effect.fnUntraced(function* (options: {
  readonly projectRef: string;
  readonly body: string;
}) {
  const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(NotFoundBody))(options.body).pipe(
    Effect.option,
  );

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

export const listCompute = Effect.fnUntraced(function* (api: ApiClient, projectRef: string) {
  const operation = "list compute";
  const response = yield* api
    .executeRaw(operationDefinitions.v2ListAllWorkers, { ref: projectRef })
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
  const decoded = yield* decodeBody(V2ListAllWorkersOutput, operation, body, response.status);
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
    .executeRaw(operationDefinitions.v2GetAWorker, { ref: projectRef, name })
    .pipe(Effect.mapError(mapRequestError(operation)));

  if (response.status === 404) {
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
  const decoded = yield* decodeBody(V2GetAWorkerOutput, operation, body, response.status);
  return Option.some(toComputeRecord(decoded.data));
});

export const createComputeUpload = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  name: string,
) {
  const operation = `stage a build context for "${name}"`;
  const response = yield* api
    .executeRaw(operationDefinitions.v2CreateWorkerUpload, { ref: projectRef, name })
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
  const decoded = yield* decodeBody(V2CreateWorkerUploadOutput, operation, body, response.status);
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
    .executeRaw(operationDefinitions.v2DeployAWorker, {
      ref: projectRef,
      name,
      data: {
        type: "project_worker",
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
  const decoded = yield* decodeBody(V2DeployAWorkerOutput, operation, body, response.status);
  return toComputeRecord(decoded.data);
});

export const deleteCompute = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  name: string,
) {
  const operation = `delete compute "${name}"`;
  const response = yield* api
    .executeRaw(operationDefinitions.v2DeleteAWorker, { ref: projectRef, name })
    .pipe(Effect.mapError(mapRequestError(operation)));

  // 404 is the caller's own "not deployed" verdict to report; a delete that
  // races another one is still a delete that happened.
  if (response.status === 204 || response.status === 200 || response.status === 404) {
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
