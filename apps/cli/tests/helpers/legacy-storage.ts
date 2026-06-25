import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { LegacyPlatformApi } from "../../src/legacy/auth/legacy-platform-api.service.ts";
import { LegacyPlatformApiFactory } from "../../src/legacy/auth/legacy-platform-api-factory.service.ts";
import { LegacyProjectNotLinkedError } from "../../src/legacy/config/legacy-project-ref.errors.ts";
import { LegacyProjectRefResolver } from "../../src/legacy/config/legacy-project-ref.service.ts";
import { LegacyYesFlag } from "../../src/shared/legacy/global-flags.ts";
import type { OutputFormat } from "../../src/shared/output/types.ts";
import { mockOutput, mockRuntimeInfo } from "./mocks.ts";
import {
  LEGACY_VALID_REF,
  legacyJsonResponse,
  legacyTransportFailure,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
} from "./legacy-mocks.ts";

/**
 * One Storage gateway / Management API mock route.
 *
 * Routes are matched in registration order and **consumed** once matched (like
 * gock mocks), so pagination and recursive flows register one route per expected
 * call. `when` further narrows a match by the parsed request body (e.g. paging by
 * `offset`). `persist` keeps a route matchable across calls (e.g. api-keys).
 */
export interface LegacyStorageRoute {
  readonly method: string;
  /** Substring matched against the request URL. */
  readonly match: string;
  readonly status?: number;
  /** Response JSON body. */
  readonly body?: unknown;
  /** Raw (non-JSON) response body, for streamed object downloads. */
  readonly rawBody?: string;
  /** When true, fail with a transport error instead of responding. */
  readonly transport?: boolean;
  readonly transportDescription?: string;
  /** Narrow the match by the parsed request body. */
  readonly when?: (reqBody: unknown) => boolean;
  /** Keep this route matchable on every call instead of consuming it. */
  readonly persist?: boolean;
}

export interface LegacyRecordedStorageRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | undefined>;
  readonly body: unknown;
}

export interface SetupLegacyStorageOptions {
  readonly toml?: string;
  readonly routes?: ReadonlyArray<LegacyStorageRoute>;
  readonly files?: Readonly<Record<string, string>>;
  readonly format?: OutputFormat;
  /** Routing is driven by the `local` field on each command's flags, not here. */
  readonly local?: boolean;
  readonly yes?: boolean;
  readonly confirm?: ReadonlyArray<boolean>;
  readonly promptConfirmFail?: boolean;
  /** Project ref returned by the resolver for the linked path. */
  readonly projectRef?: string;
  /** api-keys list returned by the Management API mock (linked path). */
  readonly apiKeys?: ReadonlyArray<{
    name: string;
    api_key?: string | null;
    type?: string | null;
    secret_jwt_template?: Record<string, unknown> | null;
  }>;
  /** When true, `loadProjectRef` fails with `LegacyProjectNotLinkedError`. */
  readonly linkedFails?: boolean;
}

/**
 * Builds the layer + recorded state for a `storage` command integration test.
 * Mirrors the seed-buckets setup: a recording `HttpClient` for the Storage
 * gateway, a config.toml on disk, a project-ref resolver, a lazy Management API
 * factory (api-keys), tracked telemetry + linked-project cache, and the
 * `--local` scoped-global flag value.
 */
export function setupLegacyStorage(workdir: string, opts: SetupLegacyStorageOptions) {
  if (opts.toml !== undefined) {
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "config.toml"), opts.toml);
  }
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = join(workdir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.confirm,
    promptConfirmFail: opts.promptConfirmFail,
  });

  const requests: Array<LegacyRecordedStorageRequest> = [];
  const consumed = new Set<number>();
  const routes = opts.routes ?? [];

  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      let body: unknown;
      if (request.body._tag === "Uint8Array") {
        try {
          body = JSON.parse(new TextDecoder().decode(request.body.body));
        } catch {
          body = undefined;
        }
      }
      requests.push({
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body,
      });
      let index = -1;
      for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        if (r === undefined) continue;
        if (consumed.has(i)) continue;
        if (r.method !== request.method) continue;
        if (!request.url.includes(r.match)) continue;
        if (r.when !== undefined && !r.when(body)) continue;
        index = i;
        break;
      }
      if (index === -1) {
        return Effect.succeed(legacyJsonResponse(request, 404, { message: "no mock route" }));
      }
      const route = routes[index]!;
      if (route.persist !== true) consumed.add(index);
      if (route.transport === true) {
        return Effect.fail(legacyTransportFailure(request, route.transportDescription));
      }
      if (route.rawBody !== undefined) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(route.rawBody, { status: route.status ?? 200 }),
          ),
        );
      }
      return Effect.succeed(legacyJsonResponse(request, route.status ?? 200, route.body ?? {}));
    }),
  );

  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedCache = mockLegacyLinkedProjectCacheTracked();

  const projectRefRef = opts.projectRef ?? LEGACY_VALID_REF;
  const notLinked = () =>
    new LegacyProjectNotLinkedError({
      message: "Cannot find project ref. Have you run supabase link?",
    });
  const projectRefLayer = Layer.succeed(LegacyProjectRefResolver, {
    resolve: () =>
      opts.linkedFails === true ? Effect.fail(notLinked()) : Effect.succeed(projectRefRef),
    resolveForLink: () =>
      opts.linkedFails === true ? Effect.fail(notLinked()) : Effect.succeed(projectRefRef),
    resolveOptional: () => Effect.succeed(Option.some(projectRefRef)),
    loadProjectRef: () =>
      opts.linkedFails === true ? Effect.fail(notLinked()) : Effect.succeed(projectRefRef),
    promptProjectRef: () => Effect.succeed(projectRefRef),
  });

  const defaultApiKeys = [
    {
      name: "service_role",
      api_key: "test-service-role-key",
      type: "secret",
      secret_jwt_template: { role: "service_role" },
    },
  ];
  const managementApi = mockLegacyPlatformApiService({
    v1: {
      getProjectApiKeys: () => Effect.succeed(opts.apiKeys ?? defaultApiKeys),
    },
  });

  const layer = Layer.mergeAll(
    out.layer,
    httpLayer,
    telemetry.layer,
    linkedCache.layer,
    mockLegacyCliConfig({ workdir }),
    BunServices.layer,
    projectRefLayer,
    Layer.succeed(LegacyPlatformApiFactory, {
      make: LegacyPlatformApi.pipe(Effect.provide(managementApi.layer)),
    }),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    // `cp` resolves relative local paths against the original cwd (Go's
    // `utils.CurrentDirAbs`); point it at the temp workdir for tests.
    mockRuntimeInfo({ cwd: workdir }),
  );

  return { layer, out, requests, telemetry, linkedCache };
}
