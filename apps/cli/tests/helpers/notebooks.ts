import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { makeApiClient } from "@supabase/api/effect";
import { Effect, Layer, Option, Predicate, Stdio } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as UrlParams from "effect/unstable/http/UrlParams";
import { CommandPlatformApi } from "../../src/auth/command-platform-api.service.ts";
import { ProjectRefNotLinkedError } from "../../src/config/project-ref.errors.ts";
import { ProjectRefResolver } from "../../src/config/project-ref.service.ts";
import { OutputFlag } from "../../src/command-internal/global-flags.ts";
import {
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
  mockCommandSettings,
  transportFailure,
} from "./command-mocks.ts";
import { mockOutput, mockContextualAnalytics, mockProcessControl } from "./mocks.ts";
import { commandRuntimeLayer } from "../../src/shared/runtime/command-runtime.layer.ts";

/**
 * Shared scaffolding for the `supabase notebooks` command integration tests.
 *
 * Both commands read and write real files under `supabase/notebooks/`, so these
 * tests run against a per-test temp project rather than a mocked filesystem —
 * what ends up on disk and what goes up to the project is most of what is worth
 * asserting. Only the network is faked.
 */

export const NOTEBOOKS_PROJECT_REF = "abcdefghijklmnopqrst";

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  /**
   * The query string, which `url` does not carry: an `HttpClientRequest` keeps
   * its parameters separate until the transport merges them, and these tests
   * intercept the request before that happens.
   */
  readonly query: URLSearchParams;
  /** The request body decoded as UTF-8. */
  readonly body: string;
}

export interface StubResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly transportError?: string;
}

/** How a test answers one request; sequential entries reply to repeated calls. */
export type RouteHandler = StubResponse | ReadonlyArray<StubResponse>;

export interface NotebooksHttpRoutes {
  /** Keyed `"<METHOD> <pathname>"`, e.g. `"GET /v2/projects/abc.../notebooks"`. */
  readonly [route: string]: RouteHandler;
}

function respond(
  request: HttpClientRequest.HttpClientRequest,
  stub: StubResponse,
): HttpClientResponse.HttpClientResponse {
  const hasBody = stub.body !== undefined;
  return HttpClientResponse.fromWeb(
    request,
    new Response(hasBody ? JSON.stringify(stub.body) : null, {
      status: stub.status,
      headers: hasBody ? { "content-type": "application/json" } : { "content-type": "text/plain" },
    }),
  );
}

export function mockNotebooksHttp(routes: NotebooksHttpRoutes) {
  const requests: Array<RecordedRequest> = [];
  const remaining = new Map<string, Array<StubResponse>>(
    Object.entries(routes).map(([route, handler]) => [
      route,
      "status" in handler ? [handler] : [...handler],
    ]),
  );

  const handle = (
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
    Effect.gen(function* () {
      const body = Predicate.isTagged(request.body, "Uint8Array")
        ? new TextDecoder().decode(request.body.body)
        : "";
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        url: request.url,
        query: new URLSearchParams(UrlParams.toString(request.urlParams)),
        body,
      });

      const key = `${request.method} ${url.pathname}`;
      const queue = remaining.get(key);
      if (queue === undefined || queue.length === 0) {
        return respond(request, { status: 599, body: { error: `unstubbed route: ${key}` } });
      }
      // The last stub for a route keeps answering, so a repeated call does not
      // have to be stubbed a fixed number of times.
      const stub = queue.length === 1 ? queue[0]! : queue.shift()!;
      if (stub.transportError !== undefined)
        return yield* Effect.fail(transportFailure(request, stub.transportError));
      return respond(request, stub);
    });

  const httpClientLayer = Layer.succeed(HttpClient.HttpClient, HttpClient.make(handle));

  const apiLayer = Layer.effect(
    CommandPlatformApi,
    makeApiClient(
      {
        baseUrl: "https://api.supabase.com",
        accessToken: "test-token",
        userAgent: "supabase",
      },
      { retry: { maxRetries: 0 } },
    ),
  ).pipe(Layer.provide(httpClientLayer));

  return {
    layer: Layer.mergeAll(apiLayer, httpClientLayer),
    requests,
    get routeKeys(): Array<string> {
      return requests.map((request) => `${request.method} ${new URL(request.url).pathname}`);
    },
  };
}

export const notebooksRoute = (suffix = "") =>
  `/v2/projects/${NOTEBOOKS_PROJECT_REF}/notebooks${suffix}`;

/** A notebook's metadata resource, as the list route's JSON:API envelope wraps it. */
export function notebookMetadata(options: { readonly id: string; readonly name: string }) {
  return {
    type: "notebook",
    id: options.id,
    attributes: {
      name: options.name,
      description: null,
      favorite: false,
      inserted_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      owner: null,
      updated_by: null,
    },
  };
}

/** One page of the list route, with `next` null unless a cursor is given. */
export function notebookListPage(options: {
  readonly notebooks: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly next?: string;
}) {
  return {
    data: options.notebooks.map(notebookMetadata),
    links: {
      first: null,
      last: null,
      prev: null,
      next: options.next === undefined ? null : options.next,
    },
  };
}

export type NotebookCell = Readonly<Record<string, unknown>>;

/** A single notebook, cells included, as the read route returns it. */
export function notebookResource(options: {
  readonly id: string;
  readonly name: string;
  readonly cells?: ReadonlyArray<NotebookCell>;
  readonly description?: string | null;
  readonly favorite?: boolean;
}) {
  const metadata = notebookMetadata(options);
  return {
    ...metadata,
    attributes: {
      ...metadata.attributes,
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.favorite === undefined ? {} : { favorite: options.favorite }),
      content: {
        schema_version: 1,
        cells: options.cells ?? [{ id: "cell-1", type: "markdown", text: "# Hello" }],
      },
    },
  };
}

/** A per-test temp project, optionally pre-seeded with files. */
export function makeNotebooksProject(files: Readonly<Record<string, string>> = {}): {
  readonly dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "supabase-notebooks-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(dir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
  return { dir };
}

/** A complete resolver mock; only resolution is replaced, never the service type. */
function testProjectRefLayer(linked: boolean) {
  const optional = (flag: Option.Option<string>) =>
    Option.orElse(flag, () => (linked ? Option.some(NOTEBOOKS_PROJECT_REF) : Option.none()));
  const resolve = (flag: Option.Option<string>) =>
    Option.match(optional(flag), {
      onSome: Effect.succeed,
      onNone: () =>
        Effect.fail(
          new ProjectRefNotLinkedError({
            message: "Cannot find project ref. Have you run supabase link?",
          }),
        ),
    });
  return Layer.succeed(ProjectRefResolver, {
    resolve,
    resolveForLink: resolve,
    resolveOptional: (flag) => Effect.succeed(optional(flag)),
    loadProjectRef: resolve,
    promptProjectRef: () => resolve(Option.none()),
  });
}

export interface NotebooksSetupOptions {
  readonly workdir: string;
  readonly format?: "text" | "json" | "stream-json";
  readonly interactive?: boolean;
  readonly linked?: boolean;
  /** Answers the reconciliation prompt: `"keep"`, `"copy"` or `"delete"`. */
  readonly promptSelectResponses?: ReadonlyArray<string>;
  readonly routes?: NotebooksHttpRoutes;
  /** The Go `-o`/`--output` flag, which every command family here honours. */
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml" | "table" | "csv";
  readonly command?: "pull";
  readonly args?: ReadonlyArray<string>;
}

export function setupNotebooks(options: NotebooksSetupOptions) {
  const out = mockOutput({
    format: options.format ?? "text",
    interactive: options.interactive ?? (options.format ?? "text") === "text",
    ...(options.promptSelectResponses === undefined
      ? {}
      : { promptSelectResponses: options.promptSelectResponses }),
  });
  const http = mockNotebooksHttp(options.routes ?? {});

  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const analytics = mockContextualAnalytics();
  const process = mockProcessControl();
  const command = options.command ?? "pull";
  return {
    out,
    http,
    telemetry,
    cache,
    analytics,
    process,
    layer: Layer.mergeAll(
      out.layer,
      http.layer,
      mockCommandSettings({ workdir: options.workdir }),
      testProjectRefLayer(options.linked !== false),
      telemetry.layer,
      cache.layer,
      analytics.layer,
      process.layer,
      commandRuntimeLayer(["notebooks", command]),
      Layer.succeed(
        OutputFlag,
        options.goOutput === undefined ? Option.none() : Option.some(options.goOutput),
      ),
      BunServices.layer,
      Stdio.layerTest({ args: Effect.succeed(options.args ?? ["notebooks", command]) }),
    ),
  };
}
