import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Redacted, Stream } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type {
  DatabaseInstance,
  Observation,
  ServiceCreation,
  ServiceInstance,
  Stack,
} from "@supabase/stack/effect";

import { CliArgs } from "../../src/shared/cli/cli-args.service.ts";
import { CommandPlatformApi } from "../../src/auth/command-platform-api.service.ts";
import { CommandPlatformApiFactory } from "../../src/auth/command-platform-api-factory.service.ts";
import { ProjectRefNotLinkedError } from "../../src/config/project-ref.errors.ts";
import { ProjectRefResolver } from "../../src/config/project-ref.service.ts";
import { YesFlag } from "../../src/command-internal/global-flags.ts";
import { StackApi } from "../../src/command-internal/stack-api.ts";
import { stackBackendLayer } from "../../src/command-internal/stack-backend.ts";
import type { OutputFormat } from "../../src/shared/output/types.ts";
import { mockOutput, mockRuntimeInfo, mockStdin, mockTty } from "./mocks.ts";
import { unusedStackServices } from "./unused-stack.ts";
import {
  VALID_REF,
  jsonResponse,
  transportFailure,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApiService,
  mockTelemetryStateTracked,
} from "./command-mocks.ts";

interface StorageRoute {
  readonly method: string;
  readonly match: string;
  readonly status?: number;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly transport?: boolean;
  readonly transportDescription?: string;
  readonly when?: (reqBody: unknown) => boolean;
  readonly persist?: boolean;
}

interface RecordedStorageRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | undefined>;
  readonly body: unknown;
}

export interface SetupStorageOptions {
  readonly toml?: string;
  readonly routes?: ReadonlyArray<StorageRoute>;
  readonly files?: Readonly<Record<string, string>>;
  readonly format?: OutputFormat;
  readonly local?: boolean;
  readonly yes?: boolean;
  readonly confirm?: ReadonlyArray<boolean>;
  readonly promptConfirmFail?: boolean;
  readonly stdinIsTty?: boolean;
  readonly pipedAnswers?: ReadonlyArray<string>;
  readonly cliArgs?: ReadonlyArray<string>;
  readonly projectRef?: string;
  readonly apiKeys?: ReadonlyArray<{
    name: string;
    api_key?: string | null;
    type?: string | null;
    secret_jwt_template?: Record<string, unknown> | null;
  }>;
  readonly linkedFails?: boolean;
  readonly explicitWorkdir?: boolean;
  readonly stackBackend?: boolean;
  readonly stackApi?: SetupStorageStackApiOptions;
}

export interface SetupStorageStackApiOptions {
  readonly present?: boolean;
  readonly found?: boolean;
  readonly lifecycle?: "running" | "starting" | "stopping" | "stopped";
  readonly storageEndpoint?: boolean;
  readonly storageWakeEnabled?: boolean;
  readonly storageState?:
    | "dormant"
    | "starting"
    | "ready"
    | "stopping"
    | "stopped"
    | "failed"
    | "disabled";
  readonly storageError?: string;
}

const STORAGE_STACK_ID = "e".repeat(64);
export const STORAGE_TEST_JWT_SECRET = "storage-test-jwt-secret-with-at-least-32-chars";
const databaseCreation: Extract<ServiceCreation, { service: "database" }> = {
  service: "database",
  config: {
    version: "17",
    databasePassword: Redacted.make("postgres"),
    jwtSecret: Redacted.make(STORAGE_TEST_JWT_SECRET),
    jwtExpiry: 3600,
  },
  endpoints: { sql: { port: 54329 } },
};
const storageCreation: Extract<ServiceCreation, { service: "storage" }> = {
  service: "storage",
  config: {
    databaseUrl: "postgresql://placeholder",
    jwtSecret: STORAGE_TEST_JWT_SECRET,
    filePath: "/tmp/storage",
  },
  endpoints: { http: { port: 59999 } },
};

const observation = (
  id: string,
  config: ServiceCreation,
  lifecycle: "running" | "starting" | "stopping" | "stopped",
  health: "starting" | "healthy" | "unhealthy" | undefined,
  wakeEnabled: boolean,
  endpoint?: {
    readonly name: string;
    readonly protocol: "tcp" | "http";
    readonly host: string;
    readonly port: number;
  },
  error?: string,
): Observation => ({
  id,
  config,
  endpoints: endpoint === undefined ? [] : [endpoint],
  lifecycle,
  health,
  error:
    error === undefined ? undefined : { _tag: "ServiceError", operation: "status", message: error },
  cleanupError: undefined,
  exit: undefined,
  currentOperation: undefined,
  launchId: undefined,
  intentRevision: 1,
  wakeEnabled,
  registered: true,
});

const instance = <K extends ServiceCreation["service"]>(
  id: string,
  creation: Extract<ServiceCreation, { service: K }>,
  status: Effect.Effect<Observation, never>,
): ServiceInstance<K> => ({
  id,
  service: creation.service,
  start: Effect.void,
  ready: Effect.void,
  stop: Effect.void,
  restart: () => Effect.void,
  destroy: Effect.void,
  prepare: Effect.void,
  status,
  followStatus: Stream.empty,
  logs: Stream.empty,
  credentials: () => Effect.succeed({}),
});

export function buildStorageStackApi(
  workdir: string,
  opts: SetupStorageStackApiOptions | undefined,
) {
  const options = opts ?? {};
  const storageState = options.storageState ?? "dormant";
  const lifecycle = options.lifecycle ?? "running";
  const storageEnabled = storageState !== "disabled";
  const storageLifecycle =
    storageState === "disabled"
      ? "stopped"
      : storageState === "dormant"
        ? "stopped"
        : storageState === "ready" || storageState === "failed"
          ? "running"
          : storageState;
  const storageHealth =
    storageState === "ready" || storageState === "dormant"
      ? "healthy"
      : storageState === "failed"
        ? "unhealthy"
        : storageState === "starting"
          ? "starting"
          : undefined;
  const storageWakeEnabled =
    options.storageWakeEnabled ?? (storageState === "dormant" || storageState === "stopping");
  const dbObservation = observation(
    "database-id",
    databaseCreation,
    lifecycle,
    lifecycle === "running" ? "healthy" : undefined,
    false,
    { name: "sql", protocol: "tcp", host: "127.0.0.1", port: 54329 },
    undefined,
  );
  const storageObservation = observation(
    "storage-id",
    storageCreation,
    storageLifecycle,
    storageHealth,
    storageWakeEnabled,
    options.storageEndpoint === false
      ? undefined
      : { name: "http", protocol: "http", host: "127.0.0.1", port: 59999 },
    options.storageError,
  );
  const database = {
    ...instance("database-id", databaseCreation, Effect.succeed(dbObservation)),
    exportSnapshot: () => Effect.die("unused"),
    restoreSnapshot: () => Effect.die("unused"),
    resetData: Effect.die("unused"),
  } satisfies DatabaseInstance;
  const storage = instance("storage-id", storageCreation, Effect.succeed(storageObservation));
  const members = storageEnabled
    ? [
        { id: database.id, activation: "eager" as const },
        { id: storage.id, activation: "lazy" as const },
      ]
    : [{ id: database.id, activation: "eager" as const }];
  const stack: Stack = {
    id: STORAGE_STACK_ID,
    services: {
      create: () => Effect.die("unused"),
      get: (id: string) =>
        id === database.id ? Effect.succeed(database) : Effect.succeed(storage),
      list: Effect.succeed(storageEnabled ? [database, storage] : [database]),
    },
    composition: {
      supabase: () => Effect.die("unused"),
      configure: () => Effect.die("unused"),
      describe: Effect.succeed({ members, dependencies: [] }),
      start: Effect.die("unused"),
      stop: Effect.die("unused"),
      restart: Effect.die("unused"),
    },
    stop: Effect.die("unused"),
    destroy: Effect.die("unused"),
    tools: { run: () => Effect.die("unused") },
  };
  const definition = {
    id: STORAGE_STACK_ID,
    identity: { projectRoot: workdir, branchContext: "main", stackName: "default" },
    runtime: "native" as const,
    instances: [
      { id: database.id, creation: databaseCreation },
      ...(storageEnabled ? [{ id: storage.id, creation: storageCreation }] : []),
    ],
    composition: { members, dependencies: [] },
    ports: [],
  };
  const findStackCalls: Array<{ readonly projectRoot: string }> = [];
  const layer =
    options.present === false
      ? Layer.succeed(StackApi, {
          create: () => Effect.die("Service not found: supabase/stack/StackApi"),
          open: () => Effect.die("Service not found: supabase/stack/StackApi"),
          discover: () => Effect.die("Service not found: supabase/stack/StackApi"),
          resolveIdentity: () => Effect.die("Service not found: supabase/stack/StackApi"),
        })
      : Layer.succeed(StackApi, {
          create: () => Effect.die("unused"),
          resolveIdentity: () => Effect.succeed(definition.identity),
          discover: () =>
            Effect.succeed(options.found === false ? [] : [{ definition, host: undefined }]),
          open: () => {
            findStackCalls.push({ projectRoot: workdir });
            return Effect.succeed(stack);
          },
        });
  return { layer, stackCalls: { findStack: findStackCalls } };
}

/**
 * Builds the layer and recorded state for a `storage` command integration test:
 * a recording `HttpClient` for the Storage gateway, an on-disk `config.toml`,
 * project-ref resolution, tracked telemetry/linked-project cache, and a lazy
 * Management API factory for api-keys.
 */
export function setupStorage(workdir: string, opts: SetupStorageOptions) {
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

  const requests: Array<RecordedStorageRequest> = [];
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
        return Effect.succeed(jsonResponse(request, 404, { message: "no mock route" }));
      }
      const route = routes[index]!;
      if (route.persist !== true) consumed.add(index);
      if (route.transport === true) {
        return Effect.fail(transportFailure(request, route.transportDescription));
      }
      if (route.rawBody !== undefined) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(route.rawBody, { status: route.status ?? 200 }),
          ),
        );
      }
      return Effect.succeed(jsonResponse(request, route.status ?? 200, route.body ?? {}));
    }),
  );

  const telemetry = mockTelemetryStateTracked();
  const linkedCache = mockLinkedProjectCacheTracked();

  const projectRefRef = opts.projectRef ?? VALID_REF;
  const notLinked = () =>
    new ProjectRefNotLinkedError({
      message: "Cannot find project ref. Have you run supabase link?",
    });
  const projectRefLayer = Layer.succeed(ProjectRefResolver, {
    resolve: () =>
      opts.linkedFails === true ? Effect.fail(notLinked()) : Effect.succeed(projectRefRef),
    resolveForLink: () =>
      opts.linkedFails === true ? Effect.fail(notLinked()) : Effect.succeed(projectRefRef),
    resolveOptional: () => Effect.succeed(Option.some(projectRefRef)),
    // An explicit `--project-ref` flag takes precedence and short-circuits before
    // `linkedFails`, so a test can resolve a ref even for an "unlinked" workdir.
    loadProjectRef: (flagValue: Option.Option<string>) =>
      Option.isSome(flagValue) && flagValue.value.length > 0
        ? Effect.succeed(flagValue.value)
        : opts.linkedFails === true
          ? Effect.fail(notLinked())
          : Effect.succeed(projectRefRef),
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
  const managementApi = mockCommandPlatformApiService({
    v1: {
      getProjectApiKeys: () => Effect.succeed(opts.apiKeys ?? defaultApiKeys),
    },
  });

  const stackApi = buildStorageStackApi(workdir, opts.stackApi);

  const layer = Layer.mergeAll(
    out.layer,
    httpLayer,
    telemetry.layer,
    linkedCache.layer,
    mockCommandSettings({ workdir, explicitWorkdir: opts.explicitWorkdir ?? false }),
    BunServices.layer,
    projectRefLayer,
    Layer.succeed(CommandPlatformApiFactory, {
      make: CommandPlatformApi.pipe(Effect.provide(managementApi.layer)),
    }),
    Layer.succeed(YesFlag, opts.yes ?? false),
    // `storage rm` confirms deletions via `promptYesNo`, answered by `confirm`;
    // other storage commands ignore it.
    mockTty({ stdinIsTty: opts.stdinIsTty ?? true, stdoutIsTty: false }),
    mockStdin(
      opts.stdinIsTty ?? true,
      opts.pipedAnswers ? `${opts.pipedAnswers.join("\n")}\n` : undefined,
    ),
    // `cp` resolves relative local paths against the original cwd; point it at
    // the temp workdir for tests.
    mockRuntimeInfo({ cwd: workdir }),
    // `resolveYes` scans the raw argv for an explicit `--yes=false`.
    Layer.succeed(CliArgs, { args: opts.cliArgs ?? [] }),
    unusedStackServices,
    stackApi.layer,
    ...(opts.stackBackend === true ? [stackBackendLayer("stack")] : []),
  );

  return { layer, out, requests, telemetry, linkedCache, stackCalls: stackApi.stackCalls };
}
