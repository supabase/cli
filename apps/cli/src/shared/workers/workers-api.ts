import {
  markSupabaseApiInputErrorAsUserInput,
  operationDefinitions,
  SupabaseApiInputError,
  V2CreateWorkerUploadOutput,
  V2DeployAWorkerOutput,
  V2GetAWorkerOutput,
  V2ListAllWorkersOutput,
  type ApiClient,
} from "@supabase/api/effect";
import { Effect, Option, Schedule, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  WorkerBuildTimeoutError,
  WorkersApiNetworkError,
  WorkerProjectNotFoundError,
  WorkersApiUnexpectedStatusError,
  WorkersUnavailableError,
  WorkerUploadFailedError,
} from "./workers.errors.ts";

/**
 * The seam every worker command talks to: `/v2/projects/{ref}/workers` on the
 * Management API.
 *
 * The routes are deliberately few — list, get, mint an upload slot, deploy,
 * delete — so this module is thin, and what it mostly adds is status handling.
 * A 404 is overloaded on these routes: it is the answer for a project outside
 * the alpha's allow-list, for a project ref that names nothing, and for a
 * worker that is not deployed. A 404 on a named worker is reported by the
 * caller as "not deployed"; one on a collection endpoint, where no worker name
 * could have been wrong, is split by its body — see {@link projectScoped404}.
 */

/** The worker shape the API returns, flattened out of its JSON:API envelope. */
export interface WorkerRecord {
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
  /** Present only on single-worker reads; a fresh deploy has nothing to report yet. */
  readonly instances?: {
    readonly declared: number;
    readonly live: number;
    readonly ready: number;
    readonly stale: number;
  };
  /** Set instead of `instances` when the instance read-through failed. */
  readonly instancesError?: string;
}

export interface WorkerUploadSlot {
  readonly uploadId: string;
  readonly url: string;
  readonly method: string;
  readonly expiresAt: string;
}

/** The `spec` a deploy sends. Mirrors the API's own field names exactly. */
export interface WorkerDeploySpec {
  readonly runtime?: string;
  readonly size: string;
  readonly exposure: string;
  readonly instances: number;
}

type WorkerResourceData = typeof V2GetAWorkerOutput.Type extends { data: infer D } ? D : never;

function toWorkerRecord(data: WorkerResourceData): WorkerRecord {
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

const workersSuggestion =
  "Workers are in private alpha. Ask in the Supabase dashboard to have this project enrolled.";

/**
 * The `error.code` a 404 carries, which is the only thing separating a project
 * outside the alpha's allow-list from one that does not exist. Both answer 404
 * on the same routes; the bodies differ:
 *
 * - not enrolled -> `{"error":{"code":"generic_not_found","message":"Workers are not available for this project"}}`
 * - no such project -> `{"error":{"code":"not_found","message":"Not Found"}}`
 */
const NotFoundBody = Schema.Struct({
  error: Schema.Struct({ code: Schema.String }),
});

/**
 * Which of the two a project-scoped 404 was.
 *
 * Only `not_found` is read as a missing project — an unrecognized body keeps
 * the enrolment answer, because that is what the alpha's allow-list has
 * historically returned and guessing the other way would send someone to check
 * a ref that is fine.
 */
const projectScoped404 = Effect.fnUntraced(function* (options: {
  readonly projectRef: string;
  readonly body: string;
}) {
  const parsed = yield* Effect.try(() => JSON.parse(options.body) as unknown).pipe(
    Effect.flatMap((json) => Schema.decodeUnknownEffect(NotFoundBody)(json)),
    Effect.option,
  );

  if (Option.isSome(parsed) && parsed.value.error.code === "not_found") {
    return new WorkerProjectNotFoundError({
      detail: `No project ${options.projectRef} was found for this account.`,
      suggestion:
        "Check the project ref, or pick the project again with `supabase link`. " +
        "If it belongs to another account, log in with `supabase login`.",
    });
  }

  return new WorkersUnavailableError({
    detail: `Workers are not available for project ${options.projectRef}.`,
    suggestion: workersSuggestion,
  });
});

/**
 * Everything that can go wrong before a status code exists: the generated input
 * schema rejecting the request, or the transport failing outright.
 */
function mapRequestError(operation: string) {
  return (error: unknown) => {
    if (error instanceof SupabaseApiInputError) {
      // The only inputs these operations take are the resolved project ref and
      // the prevalidated worker name, so a schema rejection is user-derived.
      return markSupabaseApiInputErrorAsUserInput(error);
    }
    if (HttpClientError.isHttpClientError(error)) {
      // `message` is the library's own rendering of the reason — its label, the
      // description when there is one, and the method and URL that failed.
      // These requests all go to the Management API, so that URL is safe to
      // show and is the most useful thing in the sentence.
      return new WorkersApiNetworkError({
        detail: `Could not reach the Workers API while trying to ${operation}: ${error.message}.`,
        suggestion: "Check your network connection and retry.",
      });
    }
    return new WorkersApiNetworkError({
      detail: `Could not reach the Workers API while trying to ${operation}: ${String(error)}.`,
      suggestion: "Check your network connection and retry.",
    });
  };
}

const unexpectedStatus = Effect.fnUntraced(function* (options: {
  readonly operation: string;
  readonly status: number;
  readonly body: string;
}) {
  const trimmed = options.body.trim();
  return yield* Effect.fail(
    new WorkersApiUnexpectedStatusError({
      status: options.status,
      detail: `The Workers API answered ${options.status} while trying to ${options.operation}${
        trimmed === "" ? "" : `: ${trimmed}`
      }.`,
      suggestion: "Retry shortly; if it persists, report it with `supabase issue`.",
    }),
  );
});

const decodeBody = <A, I>(
  schema: Schema.Codec<A, I>,
  operation: string,
  body: unknown,
  status: number,
) =>
  Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError(
      (error) =>
        new WorkersApiUnexpectedStatusError({
          status,
          detail: `The Workers API returned a response this CLI could not read while trying to ${operation}: ${error.message}.`,
          suggestion: "Update the CLI with `supabase update`, then retry.",
        }),
    ),
  );

export const listWorkers = Effect.fnUntraced(function* (api: ApiClient, projectRef: string) {
  const operation = "list workers";
  const response = yield* api
    .executeRaw(operationDefinitions.v2ListAllWorkers, { ref: projectRef })
    .pipe(Effect.mapError(mapRequestError(operation)));

  if (response.status === 404) {
    return yield* Effect.fail(
      yield* projectScoped404({
        projectRef,
        body: yield* response.text.pipe(Effect.orElseSucceed(() => "")),
      }),
    );
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
  return decoded.data.map(toWorkerRecord);
});

/**
 * One worker, or `None` when the API has no record of it — which is also what a
 * project outside the alpha's allow-list answers, so callers report it as "not
 * deployed" and point at `push` rather than guessing which of the two it was.
 */
export const getWorker = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  name: string,
) {
  const operation = `read worker "${name}"`;
  const response = yield* api
    .executeRaw(operationDefinitions.v2GetAWorker, { ref: projectRef, name })
    .pipe(Effect.mapError(mapRequestError(operation)));

  if (response.status === 404) {
    return Option.none<WorkerRecord>();
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
  return Option.some(toWorkerRecord(decoded.data));
});

export const createWorkerUpload = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  name: string,
) {
  const operation = `stage a build context for "${name}"`;
  const response = yield* api
    .executeRaw(operationDefinitions.v2CreateWorkerUpload, { ref: projectRef, name })
    .pipe(Effect.mapError(mapRequestError(operation)));

  if (response.status === 404) {
    return yield* Effect.fail(
      yield* projectScoped404({
        projectRef,
        body: yield* response.text.pipe(Effect.orElseSucceed(() => "")),
      }),
    );
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
  } satisfies WorkerUploadSlot;
});

/**
 * PUT the archive straight at the presigned slot. The bytes never pass through
 * the Management API, so this goes out with no Supabase credentials attached —
 * the signature in the URL is the authorization.
 *
 * That signature is why `legacyHttpClientLayer` redacts query strings before
 * logging them — under `--debug` this URL is a write-capable credential. Done
 * there rather than here, so the client stays injectable and every presigned URL
 * is covered rather than this one call site.
 */
export const uploadBuildContext = Effect.fnUntraced(function* (
  slot: WorkerUploadSlot,
  archive: Uint8Array,
) {
  const client = yield* HttpClient.HttpClient;

  // The slot names its own method; the API documents `PUT` and nothing else is
  // meaningful for a presigned object-store destination, so anything unexpected
  // falls back to it rather than assembling a request we cannot build.
  const request = (
    slot.method.toUpperCase() === "POST"
      ? HttpClientRequest.post(slot.url)
      : HttpClientRequest.put(slot.url)
  ).pipe(HttpClientRequest.bodyUint8Array(archive, "application/gzip"));

  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      (error) =>
        new WorkerUploadFailedError({
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
    return yield* Effect.fail(
      new WorkerUploadFailedError({
        detail: `Uploading the build context failed with status ${response.status}${
          body.trim() === "" ? "" : `: ${body.trim()}`
        }.`,
        suggestion: "Re-run the same command; the upload slot is minted fresh each time.",
      }),
    );
  }
});

export const deployWorker = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  name: string,
  attributes: { readonly spec: WorkerDeploySpec; readonly contextUploadId?: string },
) {
  const operation = `deploy worker "${name}"`;
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
    return yield* Effect.fail(
      yield* projectScoped404({
        projectRef,
        body: yield* response.text.pipe(Effect.orElseSucceed(() => "")),
      }),
    );
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
  return toWorkerRecord(decoded.data);
});

export const deleteWorker = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  name: string,
) {
  const operation = `delete worker "${name}"`;
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
 * The build runs asynchronously — deploy answers 202 and the worker reaches
 * `active` or `failed` later — so `push` polls `get` until `build_state` leaves
 * `building`.
 *
 * The schedule is a parameter so tests can drive the same loop without waiting
 * on wall-clock delays.
 */
const WORKER_BUILD_POLL_SCHEDULE = Schedule.spaced("2 seconds").pipe(
  Schedule.upTo({ duration: "10 minutes" }),
);

/**
 * How long one poll read is allowed to keep failing before the deploy is called
 * off.
 *
 * Bounded by elapsed time, not attempts: unspaced attempts are exhausted by a
 * two-second blip, abandoning a build the server is still running. Half a minute
 * of spaced retries rides that out, and anything still failing after it is the
 * real error.
 */
const WORKER_POLL_READ_RETRY = Schedule.spaced("2 seconds").pipe(
  Schedule.upTo({ duration: "30 seconds" }),
);

export const awaitWorkerBuild = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  name: string,
  options: {
    readonly schedule?: Schedule.Schedule<unknown>;
    /**
     * Retry schedule for one poll read. A parameter for the same reason
     * `schedule` is: it is spaced in seconds, and a test exercising the
     * transient-failure path should not wait on a real clock to do it.
     */
    readonly retrySchedule?: Schedule.Schedule<unknown>;
    /** Called with each poll's result, for progress reporting. */
    readonly onPoll?: (worker: WorkerRecord) => Effect.Effect<void>;
    /**
     * ` --project-ref <ref>` to append to the suggestion below, when the caller
     * reached this project through the flag rather than the link. The suggestion
     * is copy-pasted verbatim, so dropping it re-resolves against whatever this
     * checkout happens to be linked to.
     */
    readonly refSuffix?: string;
  } = {},
) {
  const poll = Effect.gen(function* () {
    // A build can run for minutes, so a single blip on one read should not throw
    // away a deploy that is progressing fine.
    const worker = yield* getWorker(api, projectRef, name).pipe(
      Effect.retry({ schedule: options.retrySchedule ?? WORKER_POLL_READ_RETRY }),
    );
    if (Option.isNone(worker)) {
      // The deploy was accepted, so the worker exists; a 404 here is the read
      // racing the write. Report it as still building and poll again.
      return undefined;
    }
    if (options.onPoll !== undefined) {
      yield* options.onPoll(worker.value);
    }
    return worker.value.buildState === "building" ? undefined : worker.value;
  });

  const settled = yield* poll.pipe(
    Effect.repeat({
      schedule: options.schedule ?? WORKER_BUILD_POLL_SCHEDULE,
      until: (result) => result !== undefined,
    }),
  );

  if (settled === undefined) {
    return yield* Effect.fail(
      new WorkerBuildTimeoutError({
        detail: `"${name}" was still building when this command stopped waiting.`,
        suggestion: `Check on it with \`supabase workers status ${name}${options.refSuffix ?? ""}\`.`,
      }),
    );
  }

  return settled;
});
