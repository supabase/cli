import { BunServices } from "@effect/platform-bun";
import { makeApiClient } from "@supabase/api/effect";
import { Effect, FileSystem, Layer, Option, Path, Predicate, Redacted, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { CommandPlatformApi } from "../../src/auth/command-platform-api.service.ts";
import { CommandSettings } from "../../src/config/command-settings.service.ts";
import { ProjectRefResolver } from "../../src/config/project-ref.service.ts";
import { CliArgs } from "../../src/shared/cli/cli-args.service.ts";
import { OutputFlag, YesFlag } from "../../src/command-internal/global-flags.ts";
import { randomLayer } from "../../src/shared/runtime/random.layer.ts";
import { ProjectRefNotLinkedError } from "../../src/config/project-ref.errors.ts";
import { mockLinkedProjectCacheLayer } from "./command-mocks.ts";
import { TelemetryState } from "../../src/telemetry/telemetry-state.service.ts";
import { mockOutput, mockProcessControl, mockRuntimeInfo, mockTty } from "./mocks.ts";

/**
 * Shared scaffolding for the `supabase compute` command integration tests.
 *
 * Every compute command reads a real `supabase/config.toml` and compute
 * directory, so these tests run against a per-test temp project instead of a
 * mocked filesystem; only the network is faked.
 */

export const COMPUTE_PROJECT_REF = "abcdefghijklmnopqrst";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  /**
   * Query parameters, which `url` does not carry — `HttpClientRequest` keeps them
   * separate, so a test asserting what a GET asked for must read this. The
   * analytics logs endpoint puts the whole SQL query here.
   */
  readonly urlParams: Readonly<Record<string, string>>;
  /** The request body decoded as UTF-8 — meaningful for the JSON requests. */
  readonly body: string;
  /** Byte length of the body, which is what matters for the binary upload. */
  readonly byteLength: number;
}

interface StubResponse {
  readonly status: number;
  readonly body?: unknown;
}

/**
 * A request that never reaches a status code — the connection itself failed.
 * Distinct from a `StubResponse` with an error status, which is a server that
 * answered.
 */
interface StubTransportFailure {
  readonly transportError: string;
}

function isTransportFailure(
  stub: StubResponse | StubTransportFailure,
): stub is StubTransportFailure {
  return "transportError" in stub;
}

/** How a test answers one request; sequential entries reply to repeated calls. */
type RouteHandler =
  | StubResponse
  | StubTransportFailure
  | ReadonlyArray<StubResponse | StubTransportFailure>;

export interface ComputeHttpRoutes {
  /** Keyed `"<METHOD> <pathname>"`, e.g. `"GET /v2/projects/abc.../workers"`. */
  readonly [route: string]: RouteHandler;
}

function respond(
  request: HttpClientRequest.HttpClientRequest,
  stub: StubResponse,
  encodedBody: string,
): HttpClientResponse.HttpClientResponse {
  const hasBody = stub.body !== undefined;
  return HttpClientResponse.fromWeb(
    request,
    new Response(hasBody ? encodedBody : "", {
      status: stub.status,
      headers: hasBody ? { "content-type": "application/json" } : { "content-type": "text/plain" },
    }),
  );
}

const jsonCodec = Schema.fromJsonString(Schema.Unknown);

function isRouteSequence(
  handler: RouteHandler,
): handler is ReadonlyArray<StubResponse | StubTransportFailure> {
  return Array.isArray(handler);
}

/**
 * A single HTTP stub shared by the Management API client and the presigned
 * build-context upload, so a test can assert the whole request sequence — mint
 * the slot, PUT the bytes, deploy, poll — in the order it happened.
 */
function mockComputeHttp(routes: ComputeHttpRoutes) {
  const requests: Array<RecordedRequest> = [];
  const remaining = new Map<string, Array<StubResponse | StubTransportFailure>>(
    Object.entries(routes).map(([route, handler]) => [
      route,
      isRouteSequence(handler) ? [...handler] : [handler],
    ]),
  );

  const handle = (
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
    Effect.suspend(() => {
      const bytes = Predicate.isTagged("Uint8Array")(request.body)
        ? request.body.body
        : new Uint8Array(0);
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        url: request.url,
        // UrlParams is iterable over [key, value] pairs, not an array.
        urlParams: Object.fromEntries(request.urlParams),
        body: new TextDecoder().decode(bytes),
        byteLength: bytes.length,
      });

      const key = `${request.method} ${url.pathname}`;
      const queue = remaining.get(key);
      if (queue === undefined || queue.length === 0) {
        const stub = { status: 599, body: { error: `unstubbed route: ${key}` } };
        return Schema.encodeEffect(jsonCodec)(stub.body).pipe(
          Effect.map((encodedBody) => respond(request, stub, encodedBody)),
          Effect.mapError(
            (cause) =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause,
                  description: "Failed to encode mocked JSON response",
                }),
              }),
          ),
        );
      }
      // The last stub for a route keeps answering, so a poll loop does not have
      // to be stubbed a fixed number of times.
      const stub = queue.length === 1 ? queue[0]! : queue.shift()!;
      if (isTransportFailure(stub)) {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: stub.transportError,
            }),
          }),
        );
      }
      if (stub.body === undefined) {
        return Effect.succeed(respond(request, stub, ""));
      }
      return Schema.encodeEffect(jsonCodec)(stub.body).pipe(
        Effect.map((encodedBody) => respond(request, stub, encodedBody)),
        Effect.mapError(
          (cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause,
                description: "Failed to encode mocked JSON response",
              }),
            }),
        ),
      );
    });

  const httpClientLayer = Layer.succeed(HttpClient.HttpClient, HttpClient.make(handle));

  const apiLayer = Layer.effect(
    CommandPlatformApi,
    makeApiClient({
      baseUrl: "https://api.supabase.com",
      accessToken: "test-token",
      userAgent: "supabase",
      headers: {
        "X-Supabase-Command": "compute",
        "X-Supabase-Command-Run-ID": "run-123",
      },
    }),
  ).pipe(Layer.provide(httpClientLayer));

  return {
    layer: Layer.mergeAll(apiLayer, httpClientLayer),
    requests,
    get routeKeys(): Array<string> {
      return requests.map((request) => `${request.method} ${new URL(request.url).pathname}`);
    },
  };
}

/** Compute resource JSON, as the Management API's JSON:API envelope wraps it. */
export function computeResource(options: {
  readonly name: string;
  readonly runtime?: string;
  readonly size?: string;
  readonly exposure?: string;
  readonly instances?: number;
  readonly buildState?: "building" | "active" | "failed";
  readonly stateReason?: string;
  readonly imageVersion?: string;
  readonly deleting?: boolean;
  readonly instanceCounts?: {
    declared: number;
    live: number;
    ready: number;
    stale: number;
  };
  readonly instancesError?: string;
}) {
  return {
    type: "project_worker",
    id: options.name,
    attributes: {
      spec: {
        ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
        size: options.size ?? "2gb-1vcpu",
        exposure: options.exposure ?? "public",
        instances: options.instances ?? 1,
      },
      build_state: options.buildState ?? "active",
      secret_generation: "gen-1",
      ...(options.stateReason === undefined ? {} : { state_reason: options.stateReason }),
      ...(options.imageVersion === undefined ? {} : { image_version: options.imageVersion }),
      ...(options.deleting === undefined ? {} : { deleting: options.deleting }),
      ...(options.instanceCounts === undefined ? {} : { instances: options.instanceCounts }),
      ...(options.instancesError === undefined ? {} : { instances_error: options.instancesError }),
    },
  };
}

export const computeRoute = (suffix = "") => `/v2/projects/${COMPUTE_PROJECT_REF}/workers${suffix}`;

/**
 * The unified logs endpoint `compute logs` queries. Not under `/v2/.../workers` —
 * there is no compute-scoped log route.
 */
export const computeLogsRoute = () =>
  `/v1/projects/${COMPUTE_PROJECT_REF}/analytics/endpoints/logs`;

/**
 * One row as the logs endpoint returns it, matching the projection in
 * `computeLogsQuery`.
 *
 * `log_attributes` values are all strings — the column is a
 * `Map(String, String)`, so `status` arrives as `"200"`.
 */
export function computeLogRow(options: {
  readonly id?: string;
  readonly tsMs?: number;
  readonly stream?: string;
  readonly message?: string;
  readonly compute?: string;
  readonly attributes?: Readonly<Record<string, string>>;
}) {
  const stream = options.stream ?? "worker_guest_logs";
  return {
    id: options.id ?? "row-1",
    ts_ms: options.tsMs ?? 1_788_187_532_576,
    stream,
    event_message: options.message ?? "compute shim: listening on :8080 (serving)",
    log_attributes: {
      source: stream,
      worker: options.compute ?? "api",
      project: COMPUTE_PROJECT_REF,
      ...options.attributes,
    },
  };
}

/** An HTTP access log row, whose fields live in `log_attributes`, not the message. */
export function computeIngressLogRow(options: {
  readonly id?: string;
  readonly tsMs?: number;
  readonly compute?: string;
  readonly status?: string;
  readonly method?: string;
  readonly path?: string;
  readonly durationMs?: string;
}) {
  const method = options.method ?? "GET";
  const path = options.path ?? "/";
  return computeLogRow({
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.tsMs === undefined ? {} : { tsMs: options.tsMs }),
    ...(options.compute === undefined ? {} : { compute: options.compute }),
    stream: "worker_ingress_logs",
    // Only method and path go in the message, matching the wire format.
    message: `${method} ${path}`,
    attributes: {
      method,
      path,
      status: options.status ?? "200",
      duration_ms: options.durationMs ?? "23",
      instance_id: "microvm-3f4b0c03-9310-3f72-940d-f56deeef795e",
    },
  });
}

/** A build/deploy lifecycle row. */
export function computeApiLogRow(options: {
  readonly id?: string;
  readonly tsMs?: number;
  readonly compute?: string;
  readonly event?: string;
  readonly reason?: string;
}) {
  const compute = options.compute ?? "api";
  const event = options.event ?? "deploy_accepted";
  return computeLogRow({
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.tsMs === undefined ? {} : { tsMs: options.tsMs }),
    compute,
    stream: "worker_api_logs",
    message: `${event} ${COMPUTE_PROJECT_REF}/${compute}`,
    attributes: { event, ...(options.reason === undefined ? {} : { reason: options.reason }) },
  });
}

/** A per-test temp project, optionally pre-seeded with files. */
export function makeComputeProject(files: Readonly<Record<string, string>> = {}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-compute-" });
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = path.join(dir, relativePath);
      yield* fs.makeDirectory(path.dirname(absolutePath), { recursive: true });
      yield* fs.writeFileString(absolutePath, contents);
    }
    return { dir };
  });
}

/**
 * `CommandSettings` for the compute commands: the workdir they treat as the
 * project, and the host their URLs are built on, plus every other field
 * `CommandSettingsShape` requires.
 */
const testCliConfigLayer = (workdir: string, explicitWorkdir: boolean) =>
  Layer.succeed(CommandSettings, {
    profile: "supabase",
    apiUrl: "https://api.supabase.com",
    projectHost: "supabase.co",
    poolerHost: "pooler.supabase.com",
    dashboardUrl: "https://supabase.com/dashboard",
    accessToken: Option.some(Redacted.make("sbp_test")),
    projectId: Option.none(),
    workdir,
    explicitWorkdir,
    userAgent: "supabase",
  });

/** The resolver, stubbed: `--project-ref` wins, else the linked project. */
const testProjectRefLayer = (linked: boolean) =>
  Layer.succeed(ProjectRefResolver, {
    resolve: (flagValue: Option.Option<string>) =>
      Option.isSome(flagValue)
        ? Effect.succeed(flagValue.value)
        : linked
          ? Effect.succeed(COMPUTE_PROJECT_REF)
          : Effect.fail(
              new ProjectRefNotLinkedError({
                message: "Cannot find project ref. Have you run supabase link?",
              }),
            ),
    resolveForLink: () =>
      Effect.fail(new ProjectRefNotLinkedError({ message: "Not available in compute tests" })),
    resolveOptional: () =>
      Effect.succeed(linked ? Option.some(COMPUTE_PROJECT_REF) : Option.none()),
    loadProjectRef: () =>
      Effect.fail(new ProjectRefNotLinkedError({ message: "Not available in compute tests" })),
    promptProjectRef: () =>
      Effect.fail(new ProjectRefNotLinkedError({ message: "Not available in compute tests" })),
  });

export interface ComputeSetupOptions {
  readonly workdir: string;
  /** cliSettings.explicitWorkdir override — true iff --workdir/SUPABASE_WORKDIR was set verbatim. */
  readonly explicitWorkdir?: boolean;
  /**
   * The directory the command was invoked from, when it differs from the
   * project — which is what a relative `--source` resolves against.
   */
  readonly cwd?: string;
  readonly format?: "text" | "json" | "stream-json";
  readonly interactive?: boolean;
  /**
   * Whether stdin is a terminal; defaults to `interactive`. Set false to model a
   * piped stdin with a TTY stdout, as in `printf 'api\n' | supabase compute
   * delete api`.
   */
  readonly stdinIsTty?: boolean;
  readonly linked?: boolean;
  readonly promptTextResponses?: ReadonlyArray<string>;
  readonly promptSelectResponses?: ReadonlyArray<string>;
  readonly routes?: ComputeHttpRoutes;
  /**
   * The `-o`/`--output` flag, with every value the global flag accepts —
   * including `table` and `csv`, which these commands are meant to ignore and
   * render text for.
   */
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml" | "table" | "csv";
  /** The root `--yes`, read by `delete` through `resolveYes`. */
  readonly yes?: boolean;
  /** Raw argv, which `resolveYes` scans for an explicit `--yes=false`. */
  readonly cliArgs?: ReadonlyArray<string>;
  /**
   * The signal `awaitSignal` resolves with. `logs --follow` races its poll loop
   * against this, so a test that wants the tail to end supplies one; the default
   * never fires, modelling a terminal nobody has interrupted.
   */
  readonly signal?: "SIGINT" | "SIGTERM" | "SIGHUP";
}

/**
 * `TelemetryState`, recording whether it was flushed.
 *
 * Every compute command is supposed to write the telemetry state file on every
 * invocation, success or failure — which is only observable if the mock says so,
 * so the shared always-void mock cannot cover it.
 */
function mockComputeTelemetryState() {
  let flushed = false;
  return {
    layer: Layer.succeed(TelemetryState, {
      flush: Effect.sync(() => {
        flushed = true;
      }),
      stitchLogin: () => Effect.void,
      clearDistinctId: Effect.void,
      resetIdentity: Effect.void,
    }),
    get flushed() {
      return flushed;
    },
  };
}

export function setupCompute(options: ComputeSetupOptions) {
  const interactive = options.interactive ?? (options.format ?? "text") === "text";
  const out = mockOutput({
    format: options.format ?? "text",
    interactive,
    ...(options.promptTextResponses === undefined
      ? {}
      : { promptTextResponses: options.promptTextResponses }),
    ...(options.promptSelectResponses === undefined
      ? {}
      : { promptSelectResponses: options.promptSelectResponses }),
  });
  const http = mockComputeHttp(options.routes ?? {});
  const telemetry = mockComputeTelemetryState();
  const processControl = mockProcessControl(
    options.signal === undefined ? {} : { signal: options.signal },
  );

  return {
    out,
    http,
    telemetry,
    processControl,
    layer: Layer.mergeAll(
      out.layer,
      http.layer,
      mockRuntimeInfo({ cwd: options.cwd ?? options.workdir }),
      mockTty({ stdinIsTty: options.stdinIsTty ?? interactive, stdoutIsTty: interactive }),
      testCliConfigLayer(options.workdir, options.explicitWorkdir ?? false),
      testProjectRefLayer(options.linked !== false),
      telemetry.layer,
      mockLinkedProjectCacheLayer,
      randomLayer,
      Layer.succeed(
        OutputFlag,
        options.goOutput === undefined ? Option.none() : Option.some(options.goOutput),
      ),
      Layer.succeed(YesFlag, options.yes ?? false),
      Layer.succeed(CliArgs, { args: options.cliArgs ?? [] }),
      processControl.layer,
      BunServices.layer,
    ),
  };
}
