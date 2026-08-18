import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { makeApiClient } from "@supabase/api/effect";
import { Effect, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { PlatformApi } from "../../src/next/auth/platform-api.service.ts";
import type { ProjectLinkStateValue } from "../../src/next/config/project-link-state.service.ts";
import { CliConfig } from "../../src/next/config/cli-config.service.ts";
import { randomLayer } from "../../src/shared/runtime/random.layer.ts";
import { mockOutput, mockProjectLinkState, mockRuntimeInfo } from "./mocks.ts";

/**
 * Shared scaffolding for the `supabase workers` command integration tests.
 *
 * Every worker command reads a real `supabase/config.toml` and a real worker
 * directory, so these tests run against a per-test temp project rather than a
 * mocked filesystem — the config-writing and packaging behaviour is most of
 * what is worth asserting. Only the network is faked.
 */

export const WORKERS_PROJECT_REF = "abcdefghijklmnopqrst";

export const WORKERS_LINK_STATE: ProjectLinkStateValue = {
  project: {
    ref: WORKERS_PROJECT_REF,
    name: "Linked Project",
    organization_id: "org-id",
    organization_slug: "org-slug",
  },
  active_branch: { ref: "branchrefabcdefghij", name: "main", is_default: true },
  fetchedAt: "2026-01-01T00:00:00.000Z",
  versions: {},
};

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
    PlatformApi,
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

export interface WorkersSetupOptions {
  readonly cwd: string;
  readonly format?: "text" | "json" | "stream-json";
  readonly interactive?: boolean;
  readonly linked?: boolean;
  readonly promptTextResponses?: ReadonlyArray<string>;
  readonly promptSelectResponses?: ReadonlyArray<string>;
  readonly routes?: WorkersHttpRoutes;
}

const testCliConfigLayer = (cwd: string) =>
  Layer.succeed(
    CliConfig,
    CliConfig.of({
      apiUrl: "https://api.supabase.com",
      dashboardUrl: "https://supabase.com/dashboard",
      projectHost: "supabase.co",
      telemetryPosthogHost: "https://us.i.posthog.com",
      telemetryPosthogKey: Option.some("phc_test_key"),
      accessToken: Option.none(),
      noKeyring: Option.none(),
      supabaseHome: join(cwd, ".cache", "supabase"),
      debug: Option.none(),
      telemetryDebug: Option.none(),
      telemetryDisabled: Option.none(),
      doNotTrack: Option.none(),
    }),
  );

export function setupWorkers(options: WorkersSetupOptions) {
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

  return {
    out,
    http,
    layer: Layer.mergeAll(
      out.layer,
      http.layer,
      mockRuntimeInfo({ cwd: options.cwd }),
      mockProjectLinkState(options.linked === false ? undefined : WORKERS_LINK_STATE),
      testCliConfigLayer(options.cwd),
      randomLayer,
      BunServices.layer,
    ),
  };
}

/** Messages of a given kind, in the order the handler emitted them. */
export function messagesOfType(
  out: ReturnType<typeof mockOutput>,
  type: "info" | "warn" | "error" | "success" | "intro" | "outro" | "fail",
): Array<string> {
  return out.messages.filter((message) => message.type === type).map((message) => message.message);
}
