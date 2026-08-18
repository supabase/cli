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
 * The alpha's allow-list answers 404 for a project that is not enrolled, which
 * at the transport level is indistinguishable from "no such worker"; so a 404
 * on a collection endpoint (where no worker name could have been wrong) becomes
 * {@link WorkersUnavailableError}, and a 404 on a named worker is reported by
 * the caller as "not deployed".
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
      const description = error.reason.description ?? error.reason._tag;
      return new WorkersApiNetworkError({
        detail: `Could not reach the Workers API while trying to ${operation}: ${description}.`,
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
      new WorkersUnavailableError({
        detail: `Workers are not available for project ${projectRef}.`,
        suggestion: workersSuggestion,
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
const getWorker = Effect.fnUntraced(function* (api: ApiClient, projectRef: string, name: string) {
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
      new WorkersUnavailableError({
        detail: `Workers are not available for project ${projectRef}.`,
        suggestion: workersSuggestion,
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
 * the Management API, so this goes out on the plain HTTP client with no
 * Supabase credentials attached — the signature in the URL is the authorization.
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
          detail: `Uploading the build context failed: ${
            error.reason.description ?? error.reason._tag
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
      new WorkersUnavailableError({
        detail: `Workers are not available for project ${projectRef}.`,
        suggestion: workersSuggestion,
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

export const awaitWorkerBuild = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  name: string,
  options: {
    readonly schedule?: Schedule.Schedule<unknown>;
    /** Called with each poll's result, for progress reporting. */
    readonly onPoll?: (worker: WorkerRecord) => Effect.Effect<void>;
  } = {},
) {
  const poll = Effect.gen(function* () {
    // A build can run for minutes, so a single blip on one read should not throw
    // away a deploy that is progressing fine. A few immediate retries absorb
    // that; anything that keeps failing is reported as the real error rather
    // than silently waited out until the timeout.
    const worker = yield* getWorker(api, projectRef, name).pipe(
      Effect.retry({ schedule: Schedule.recurs(2) }),
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
        suggestion: `Check on it with \`supabase workers status ${name}\`.`,
      }),
    );
  }

  return settled;
});
