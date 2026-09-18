import {
  operationDefinitions,
  V2CreateComputeInstanceUploadOutput,
  V2DeployAComputeInstanceOutput,
  V2GetAComputeInstanceOutput,
  V2ListAllComputeInstancesOutput,
  type ApiClient,
} from "@supabase/api/effect";
import { Effect, Option, Schedule } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  bodyText,
  decodeJsonBody,
  hasErrorCode,
  mapRequestError,
  parse404,
  projectNotFound,
  unexpectedStatus,
  unroutedPath,
} from "./compute-api-status.ts";
import {
  ComputeBuildTimeoutError,
  ComputeProjectNotFoundError,
  ComputeRouteNotFoundError,
  ComputeUnavailableError,
  ComputeUploadFailedError,
} from "./compute.errors.ts";

/**
 * The seam every compute command talks to: `/v2/projects/{ref}/compute` on the Management API.
 *
 * Four unrelated conditions answer 404 here, and `error.code` is the only thing that tells them
 * apart:
 *
 * | condition | code |
 * | --- | --- |
 * | project outside the alpha's allow-list | `not_found.compute.not_enabled` |
 * | no such project | `not_found` |
 * | no such route | `not_found`, with the router's own `Cannot GET /v2/...` message |
 * | no compute deployed under that name | `not_found.compute.instance` |
 *
 * Only `GET /compute/{name}` and `DELETE /compute/{name}` can mean the last one: every other
 * route — list, uploads, deploy — cannot mean an absent compute, since an enrolled project with
 * none answers `200 {"data":[]}` and uploads and deploy create. So those classify through
 * {@link projectScoped404}, and the two named routes go through
 * {@link refuseUnreachableCompute}, which fails on the first three and returns on anything else
 * so the caller can read it as "not deployed".
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

/** The code the API answers with for a project outside the alpha's allow-list. */
const NOT_ENROLLED_CODE = "not_found.compute.not_enabled";

const notEnrolled = (projectRef: string) =>
  new ComputeUnavailableError({
    detail: `Compute is not available for project ${projectRef}.`,
    suggestion: "Compute is in private alpha. Stay tuned for the public alpha coming soon.",
  });

const routeNotFound = (projectRef: string, route: string) =>
  new ComputeRouteNotFoundError({
    detail: `The Management API does not serve ${route}, so this CLI cannot reach compute for project ${projectRef}.`,
    // Compute is an allow-listed alpha, so neither a newer CLI nor enrolment puts a route back.
    suggestion: "Report it with `supabase issue`, including the route named above.",
  });

/**
 * Fails when a named-compute 404 was not about the compute at all — the route is unserved, the
 * project is not in the alpha, or there is no such project — and returns otherwise so the caller
 * can read it as "not deployed". Without it, an unenrolled project is told its compute is not
 * deployed, and `delete` claims it removed something it never reached.
 *
 * The absence itself carries `not_found.compute.instance`, so it falls through here along with
 * any body this CLI does not recognize: on these two routes "not deployed" is the 404 that
 * nothing else claimed.
 */
const refuseUnreachableCompute = Effect.fnUntraced(function* (projectRef: string, body: string) {
  const parsed = yield* parse404(body);
  const route = unroutedPath(parsed);

  if (Option.isSome(route)) return yield* routeNotFound(projectRef, route.value);
  if (hasErrorCode(parsed, NOT_ENROLLED_CODE)) return yield* notEnrolled(projectRef);
  if (hasErrorCode(parsed, "not_found")) return yield* projectNotFound(projectRef);
});

/** Fails with whichever condition a collection-endpoint 404 was; none of them can mean an absence there. */
const projectScoped404 = Effect.fnUntraced(function* (projectRef: string, body: string) {
  yield* refuseUnreachableCompute(projectRef, body);

  // Unavailable is the safe default for an unrecognized body: guessing the other way would send
  // someone to check a ref that is actually fine.
  return yield* notEnrolled(projectRef);
});

export const listCompute = Effect.fnUntraced(function* (api: ApiClient, projectRef: string) {
  const operation = "list compute";
  const response = yield* api
    .executeRaw(operationDefinitions.v2ListAllComputeInstances, { ref: projectRef })
    .pipe(Effect.mapError(mapRequestError(operation)));

  if (response.status === 404) {
    return yield* projectScoped404(projectRef, yield* bodyText(response));
  }
  if (response.status !== 200) {
    return yield* unexpectedStatus(operation, response);
  }

  const decoded = yield* decodeJsonBody(V2ListAllComputeInstancesOutput, operation, response);
  return decoded.data.map(toComputeRecord);
});

/** One compute, or `None` when this project has no record of it — see the 404 notes above. */
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
    yield* refuseUnreachableCompute(projectRef, yield* bodyText(response));
    return Option.none<ComputeRecord>();
  }
  if (response.status !== 200) {
    return yield* unexpectedStatus(operation, response);
  }

  const decoded = yield* decodeJsonBody(V2GetAComputeInstanceOutput, operation, response);
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
    return yield* projectScoped404(projectRef, yield* bodyText(response));
  }
  if (response.status !== 201 && response.status !== 200) {
    return yield* unexpectedStatus(operation, response);
  }

  const decoded = yield* decodeJsonBody(V2CreateComputeInstanceUploadOutput, operation, response);
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
          // Not `error.message` as elsewhere in this module: it appends the URL that failed,
          // and here that URL is the write-capable signature.
          detail: `Uploading the build context failed: ${
            error.reason.description ?? "the upload request did not complete"
          }.`,
          suggestion: "Check your network connection, then re-run the same command.",
        }),
    ),
  );

  if (response.status < 200 || response.status >= 300) {
    const body = yield* bodyText(response);
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
    return yield* projectScoped404(projectRef, yield* bodyText(response));
  }
  if (response.status !== 202 && response.status !== 200 && response.status !== 201) {
    return yield* unexpectedStatus(operation, response);
  }

  const decoded = yield* decodeJsonBody(V2DeployAComputeInstanceOutput, operation, response);
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

  // A 404 no other condition claimed is the caller's own "not deployed" verdict
  // to report; a delete that races another one is still a delete that happened.
  // The three that `refuseUnreachableCompute` does claim fail instead, so this
  // cannot report removing something it never reached.
  if (response.status === 404) {
    return yield* refuseUnreachableCompute(projectRef, yield* bodyText(response));
  }
  if (response.status === 204 || response.status === 200) {
    return;
  }

  return yield* unexpectedStatus(operation, response);
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

/**
 * Verdicts about the route, the project or its enrolment, none of which a retry can change — so
 * these surface on the first read instead of holding the poll open for the full retry window.
 */
const isPermanentReadFailure = (error: unknown) =>
  error instanceof ComputeRouteNotFoundError ||
  error instanceof ComputeUnavailableError ||
  error instanceof ComputeProjectNotFoundError;

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
     * ` --project-ref <ref>` to append to the timeout suggestion, so re-running it cannot
     * re-resolve against whatever this checkout happens to be linked to.
     */
    readonly refSuffix?: string;
  } = {},
) {
  const poll = Effect.gen(function* () {
    // A build runs for minutes; one blip on one read must not abandon a deploy that is fine.
    const compute = yield* getCompute(api, projectRef, name).pipe(
      Effect.retry({
        schedule: options.retrySchedule ?? COMPUTE_POLL_READ_RETRY,
        while: (error) => !isPermanentReadFailure(error),
      }),
    );
    if (Option.isNone(compute)) {
      // The deploy was accepted, so a 404 here is the read racing the write, not an absence.
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
