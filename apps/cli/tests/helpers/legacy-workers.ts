import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { makeApiClient } from "@supabase/api/effect";
import { Effect, Layer, Option, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { LegacyPlatformApi } from "../../src/legacy/auth/legacy-platform-api.service.ts";
import { LegacyCliSettings } from "../../src/legacy/config/legacy-cli-settings.service.ts";
import { LegacyProjectRefResolver } from "../../src/legacy/config/legacy-project-ref.service.ts";
import { CliArgs } from "../../src/shared/cli/cli-args.service.ts";
import { LegacyOutputFlag, LegacyYesFlag } from "../../src/shared/legacy/global-flags.ts";
import { randomLayer } from "../../src/shared/runtime/random.layer.ts";
import { LegacyProjectNotLinkedError } from "../../src/legacy/config/legacy-project-ref.errors.ts";
import { mockLegacyLinkedProjectCacheLayer } from "./legacy-mocks.ts";
import { LegacyTelemetryState } from "../../src/legacy/telemetry/legacy-telemetry-state.service.ts";
import { mockOutput, mockRuntimeInfo } from "./mocks.ts";

/**
 * Shared scaffolding for the `supabase workers` command integration tests.
 *
 * Every worker command reads a real `supabase/config.toml` and a real worker
 * directory, so these tests run against a per-test temp project rather than a
 * mocked filesystem — the config-writing and packaging behaviour is most of
 * what is worth asserting. Only the network is faked.
 */

export const WORKERS_PROJECT_REF = "abcdefghijklmnopqrst";

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  /** The request body decoded as UTF-8 — meaningful for the JSON requests. */
  readonly body: string;
  /** Byte length of the body, which is what matters for the binary upload. */
  readonly byteLength: number;
}

export interface StubResponse {
  readonly status: number;
  readonly body?: unknown;
}

/** How a test answers one request; sequential entries reply to repeated calls. */
export type RouteHandler = StubResponse | ReadonlyArray<StubResponse>;

export interface WorkersHttpRoutes {
  /** Keyed `"<METHOD> <pathname>"`, e.g. `"GET /v2/projects/abc.../workers"`. */
  readonly [route: string]: RouteHandler;
}

function respond(
  request: HttpClientRequest.HttpClientRequest,
  stub: StubResponse,
): HttpClientResponse.HttpClientResponse {
  const hasBody = stub.body !== undefined;
  return HttpClientResponse.fromWeb(
    request,
    new Response(hasBody ? JSON.stringify(stub.body) : "", {
      status: stub.status,
      headers: hasBody ? { "content-type": "application/json" } : { "content-type": "text/plain" },
    }),
  );
}

/**
 * A single HTTP stub shared by the Management API client and the presigned
 * build-context upload, so a test can assert the whole request sequence — mint
 * the slot, PUT the bytes, deploy, poll — in the order it happened.
 */
export function mockWorkersHttp(routes: WorkersHttpRoutes) {
  const requests: Array<RecordedRequest> = [];
  const remaining = new Map<string, Array<StubResponse>>(
    Object.entries(routes).map(([route, handler]) => [
      route,
      Array.isArray(handler) ? [...handler] : [handler as StubResponse],
    ]),
  );

  const handle = (
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
    Effect.sync(() => {
      const bytes = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array(0);
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        url: request.url,
        body: new TextDecoder().decode(bytes),
        byteLength: bytes.length,
      });

      const key = `${request.method} ${url.pathname}`;
      const queue = remaining.get(key);
      if (queue === undefined || queue.length === 0) {
        return respond(request, { status: 599, body: { error: `unstubbed route: ${key}` } });
      }
      // The last stub for a route keeps answering, so a poll loop does not have
      // to be stubbed a fixed number of times.
      const stub = queue.length === 1 ? queue[0]! : queue.shift()!;
      return respond(request, stub);
    });

  const httpClientLayer = Layer.succeed(HttpClient.HttpClient, HttpClient.make(handle));

  const apiLayer = Layer.effect(
    LegacyPlatformApi,
    makeApiClient({
      baseUrl: "https://api.supabase.com",
      accessToken: "test-token",
      userAgent: "supabase",
      headers: {
        "X-Supabase-Command": "workers",
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

/** Worker resource JSON, as the Management API's JSON:API envelope wraps it. */
export function workerResource(options: {
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

export const workersRoute = (suffix = "") => `/v2/projects/${WORKERS_PROJECT_REF}/workers${suffix}`;

/** A per-test temp project, optionally pre-seeded with files. */
export function makeWorkersProject(files: Readonly<Record<string, string>> = {}): {
  readonly dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "supabase-workers-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(dir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
  return { dir };
}

/**
 * `LegacyCliSettings`, trimmed to what the worker commands read: the workdir they
 * treat as the project, and the host their URLs are built on.
 */
const legacyTestCliConfigLayer = (workdir: string) =>
  Layer.succeed(LegacyCliSettings, {
    profile: "supabase",
    apiUrl: "https://api.supabase.com",
    projectHost: "supabase.co",
    poolerHost: "pooler.supabase.com",
    dashboardUrl: "https://supabase.com/dashboard",
    accessToken: Option.some(Redacted.make("sbp_test")),
    projectId: Option.none(),
    workdir,
    userAgent: "supabase",
  } as unknown as LegacyCliSettings["Service"]);

/** The resolver, stubbed: `--project-ref` wins, else the linked project. */
const legacyTestProjectRefLayer = (linked: boolean) =>
  Layer.succeed(LegacyProjectRefResolver, {
    resolve: (flagValue: Option.Option<string>) =>
      Option.isSome(flagValue)
        ? Effect.succeed(flagValue.value)
        : linked
          ? Effect.succeed(WORKERS_PROJECT_REF)
          : Effect.fail(
              new LegacyProjectNotLinkedError({
                message: "Cannot find project ref. Have you run supabase link?",
              }),
            ),
  } as unknown as LegacyProjectRefResolver["Service"]);

export interface WorkersSetupOptions {
  readonly workdir: string;
  /**
   * The directory the command was invoked from, when it differs from the
   * project — which is what a relative `--source` resolves against.
   */
  readonly cwd?: string;
  readonly format?: "text" | "json" | "stream-json";
  readonly interactive?: boolean;
  readonly linked?: boolean;
  readonly promptTextResponses?: ReadonlyArray<string>;
  readonly promptSelectResponses?: ReadonlyArray<string>;
  readonly routes?: WorkersHttpRoutes;
  /**
   * The `-o`/`--output` flag, with every value the global flag accepts —
   * including `table` and `csv`, which these commands are meant to ignore and
   * render text for.
   */
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml" | "table" | "csv";
  /** The root `--yes`, read by `delete` through `legacyResolveYes`. */
  readonly yes?: boolean;
  /** Raw argv, which `legacyResolveYes` scans for an explicit `--yes=false`. */
  readonly cliArgs?: ReadonlyArray<string>;
}

/**
 * `LegacyTelemetryState`, recording whether it was flushed.
 *
 * Every worker command is supposed to write the telemetry state file on every
 * invocation, success or failure — which is only observable if the mock says so,
 * so the shared always-void mock cannot cover it.
 */
function mockWorkersTelemetryState() {
  let flushed = false;
  return {
    layer: Layer.succeed(LegacyTelemetryState, {
      flush: Effect.sync(() => {
        flushed = true;
      }),
      stitchLogin: () => Effect.void,
      clearDistinctId: Effect.void,
      resetIdentity: Effect.void,
    } as unknown as LegacyTelemetryState["Service"]),
    get flushed() {
      return flushed;
    },
  };
}

export function setupLegacyWorkers(options: WorkersSetupOptions) {
  const out = mockOutput({
    format: options.format ?? "text",
    interactive: options.interactive ?? (options.format ?? "text") === "text",
    ...(options.promptTextResponses === undefined
      ? {}
      : { promptTextResponses: options.promptTextResponses }),
    ...(options.promptSelectResponses === undefined
      ? {}
      : { promptSelectResponses: options.promptSelectResponses }),
  });
  const http = mockWorkersHttp(options.routes ?? {});
  const telemetry = mockWorkersTelemetryState();

  return {
    out,
    http,
    telemetry,
    layer: Layer.mergeAll(
      out.layer,
      http.layer,
      mockRuntimeInfo({ cwd: options.cwd ?? options.workdir }),
      legacyTestCliConfigLayer(options.workdir),
      legacyTestProjectRefLayer(options.linked !== false),
      telemetry.layer,
      mockLegacyLinkedProjectCacheLayer,
      randomLayer,
      Layer.succeed(
        LegacyOutputFlag,
        options.goOutput === undefined ? Option.none() : Option.some(options.goOutput),
      ),
      Layer.succeed(LegacyYesFlag, options.yes ?? false),
      Layer.succeed(CliArgs, { args: options.cliArgs ?? [] }),
      BunServices.layer,
    ),
  };
}
