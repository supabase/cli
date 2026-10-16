import { BunServices } from "@effect/platform-bun";
import { makeApiClient } from "@supabase/api/effect";
import { Effect, FileSystem, Layer, Option, Path, Predicate, Stdio } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";
import { CommandPlatformApiFactory } from "../../src/auth/command-platform-api-factory.service.ts";
import { CommandPlatformApi } from "../../src/auth/command-platform-api.service.ts";
import { ProjectRefNotLinkedError } from "../../src/config/project-ref.errors.ts";
import { projectRefLayer } from "../../src/config/project-ref.layer.ts";
import { commandTargetLayer } from "../../src/shared/output/command-target.layer.ts";
import { ProjectRefResolver } from "../../src/config/project-ref.service.ts";
import { OutputFlag, YesFlag } from "../../src/command-internal/global-flags.ts";
import { TargetPolicy } from "../../src/command-internal/target/target-policy.ts";
import { CliArgs } from "../../src/shared/cli/cli-args.service.ts";
import {
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
  mockCommandSettings,
  transportFailure,
} from "./command-mocks.ts";
import { mockOutput, mockContextualAnalytics, mockProcessControl, mockTty } from "./mocks.ts";
import { realLinkedProjectCache } from "./permission-real-layers.ts";
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

interface RecordedRequest {
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

interface StubResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly transportError?: string;
}

/** How a test answers one request; sequential entries reply to repeated calls. */
type RouteHandler = StubResponse | ReadonlyArray<StubResponse>;

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

function mockNotebooksHttp(routes: NotebooksHttpRoutes) {
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
        return yield* transportFailure(request, stub.transportError);
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
    httpClientLayer,
    requests,
    get routeKeys(): Array<string> {
      return requests.map((request) => `${request.method} ${new URL(request.url).pathname}`);
    },
    /** The requests in the shape the permission drift helpers take. */
    get driftRequests() {
      return requests.map(({ method, url, query }) => ({
        method,
        url,
        urlParams: query.toString(),
      }));
    },
  };
}

export const notebooksRoute = (suffix = "") =>
  `/v2/projects/${NOTEBOOKS_PROJECT_REF}/notebooks${suffix}`;

/** A notebook's metadata resource, as the list route's JSON:API envelope wraps it. */
function notebookMetadata(options: { readonly id: string; readonly name: string }) {
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

/** The `supabase/notebooks/` files of a test project, read and written through `FileSystem`. */
export function notebooksProject(dir: string) {
  const file = Effect.fnUntraced(function* (name: string) {
    const path = yield* Path.Path;
    return path.join(dir, "supabase", "notebooks", `${name}.json`);
  });
  return {
    dir,
    write: Effect.fnUntraced(function* (name: string, contents: string) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const target = yield* file(name);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, contents);
    }),
    read: Effect.fnUntraced(function* (name: string) {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(yield* file(name));
    }),
    exists: Effect.fnUntraced(function* (name: string) {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.exists(yield* file(name));
    }),
  };
}

/** A complete resolver mock; only resolution is replaced, never the service type. */
function testProjectRefLayer(linked: boolean) {
  const optional = (flag: Option.Option<string>) =>
    Option.orElse(flag, () => (linked ? Option.some(NOTEBOOKS_PROJECT_REF) : Option.none()));
  const resolve = (flag: Option.Option<string>): Effect.Effect<string, ProjectRefNotLinkedError> =>
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
    resolveRef: (flag) =>
      resolve(flag).pipe(
        Effect.map((ref) => ({ ref, source: "file" as const, matchesLinkedRef: true })),
      ),
    resolveForLink: resolve,
    resolveOptional: (flag) => Effect.succeed(optional(flag)),
    promptProjectRef: () => resolve(Option.none()),
  });
}

export interface NotebooksSetupOptions {
  readonly workdir: string;
  readonly format?: "text" | "json" | "stream-json";
  readonly interactive?: boolean;
  /** Picks the mock resolver's linkage; ignored with `realLayers`, where the workdir's ref file decides. */
  readonly linked?: boolean;
  /** Answers the reconciliation prompt: `"keep"`, `"copy"` or `"delete"`. */
  readonly promptSelectResponses?: ReadonlyArray<string>;
  /** Answers the hosted-mutation confirmation. */
  readonly promptConfirmResponses?: ReadonlyArray<boolean>;
  readonly routes?: NotebooksHttpRoutes;
  /** The `-o`/`--output` flag, which every command family here honours. */
  readonly outputFlag?: "env" | "pretty" | "json" | "toml" | "yaml" | "table" | "csv";
  readonly command?: "pull" | "push";
  readonly args?: ReadonlyArray<string>;
  /** The global `--yes` flag; on by default so push tests are not blocked by the hosted-mutation consent. */
  readonly yes?: boolean;
  /**
   * Runs the real `projectRefLayer` (an unlinked workdir reaches its picker) and the real
   * linked-project cache, so their `GET /v1/projects` and `GET /v1/projects/{ref}` calls go
   * through `routes`. Linkage then comes from the workdir's `.temp/project-ref`, not `linked`.
   */
  readonly realLayers?: boolean;
}

export function setupNotebooks(options: NotebooksSetupOptions) {
  const interactive = options.interactive ?? (options.format ?? "text") === "text";
  const out = mockOutput({
    format: options.format ?? "text",
    interactive,
    ...(options.promptSelectResponses === undefined
      ? {}
      : { promptSelectResponses: options.promptSelectResponses }),
    ...(options.promptConfirmResponses === undefined
      ? {}
      : { promptConfirmResponses: options.promptConfirmResponses }),
  });
  const http = mockNotebooksHttp(options.routes ?? {});

  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const cliSettings =
    options.realLayers === true
      ? mockCommandSettings({ workdir: options.workdir, projectId: Option.none() })
      : mockCommandSettings({ workdir: options.workdir });
  const projectRef =
    options.realLayers === true
      ? projectRefLayer.pipe(
          Layer.provide(
            Layer.succeed(CommandPlatformApiFactory, {
              make: CommandPlatformApi.pipe(Effect.provide(http.layer)),
            }),
          ),
          Layer.provide(cliSettings),
          Layer.provide(mockTty({ stdinIsTty: true })),
          Layer.provide(commandTargetLayer.pipe(Layer.provide(out.layer))),
          Layer.provide(out.layer),
          Layer.provide(BunServices.layer),
        )
      : testProjectRefLayer(options.linked !== false);
  const linkedProjectCache =
    options.realLayers === true
      ? realLinkedProjectCache({ httpClient: http.httpClientLayer, cliSettings })
      : cache.layer;
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
      cliSettings,
      projectRef,
      telemetry.layer,
      linkedProjectCache,
      analytics.layer,
      process.layer,
      commandRuntimeLayer(["notebooks", command]).pipe(Layer.provide(BunServices.layer)),
      Layer.succeed(
        OutputFlag,
        options.outputFlag === undefined ? Option.none() : Option.some(options.outputFlag),
      ),
      BunServices.layer,
      Stdio.layerTest({ args: Effect.succeed(options.args ?? ["notebooks", command]) }),
      Layer.succeed(YesFlag, options.yes ?? true),
      Layer.succeed(CliArgs, { args: [] }),
      mockTty({ stdinIsTty: interactive, stdoutIsTty: interactive }),
      Layer.succeed(TargetPolicy, { group: "hosted", consent: command === "push" ? "no" : "none" }),
    ),
  };
}
