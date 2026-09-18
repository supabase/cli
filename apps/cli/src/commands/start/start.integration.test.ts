import { cliConfigProviderLayer } from "../../shared/config/cli-config-provider.layer.ts";
import { resolveStartContainerEnvValues } from "../../config/command-settings.layer.ts";
import { generateKeyPairSync } from "node:crypto";

import { BunServices } from "@effect/platform-bun";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Predicate,
  Schema,
  Sink,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { vi } from "vitest";

import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  useTempWorkdir,
  sequentialExecBatch,
  withEnvVar,
} from "../../../tests/helpers/command-mocks.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { classifyCliCauseActionability } from "../../shared/telemetry/error-actionability.ts";
import {
  DebugFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  YesFlag,
} from "../../command-internal/global-flags.ts";
import { CommandPlatformApiFactory } from "../../auth/command-platform-api-factory.service.ts";
import { serviceContainerIds, serviceContainerName } from "../../command-internal/docker-ids.ts";
import { DbConnection, type DbSession } from "../../command-internal/db-connection.service.ts";
import { dockerRunLayer } from "../../command-internal/docker-run.layer.ts";
import { START_EXCLUDABLE_KEYS } from "./start.exclude.ts";
import type { StartFlags } from "./start.command.ts";
import { start } from "./start.handler.ts";
import { KONG_LOCAL_TLS_CERT, KONG_LOCAL_TLS_KEY } from "./templates/kong-local-tls.ts";

/**
 * Counts real invocations of `resolveLocalConfigValues` across this file (every test delegates
 * to the real implementation). `start`'s success-path status print must reuse the same resolved
 * `values` bring-up already used to build every container spec — calling it again re-signs
 * `auth.signing_keys_path` JWTs with a different `exp`, producing a byte-different key than the
 * one already baked into the running containers.
 */
const resolveLocalConfigValuesCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../command-internal/local-config-values.ts", () =>
  vi
    .importActual<typeof import("../../command-internal/local-config-values.ts")>(
      "../../command-internal/local-config-values.ts",
    )
    .then((actual) => ({
      ...actual,
      resolveLocalConfigValues: (...args: Parameters<typeof actual.resolveLocalConfigValues>) => {
        resolveLocalConfigValuesCalls.count++;
        return actual.resolveLocalConfigValues(...args);
      },
    })),
);

const tempRoot = useTempWorkdir("supabase-start-int-");

function flags(overrides: Partial<StartFlags> = {}): StartFlags {
  return {
    exclude: overrides.exclude ?? [],
    ignoreHealthCheck: overrides.ignoreHealthCheck ?? false,
    preview: overrides.preview ?? false,
  };
}

const writeConfig = Effect.fnUntraced(function* (workdir: string, contents: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const supabaseDir = path.join(workdir, "supabase");
  yield* fs.makeDirectory(supabaseDir, { recursive: true });
  yield* fs.writeFileString(path.join(supabaseDir, "config.toml"), contents);
});

interface SpawnRecord {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Bare `-e KEY` (no inline value) flags deliver their value via the spawned process's own env, not argv — see `edge-runtime.service.ts`'s header. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

type RouteResult = {
  readonly exitCode?: number;
  readonly stdout?: ReadonlyArray<string>;
  readonly stderr?: ReadonlyArray<string>;
};

function concatByteChunks(chunks: ReadonlyArray<unknown>): Uint8Array | undefined {
  let byteLength = 0;
  for (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) return undefined;
    byteLength += chunk.byteLength;
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) return undefined;
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Resolves each spawned invocation immediately (no fake async delay) — unlike
 * `stop.integration.test.ts`'s `mockRoutedContainerCliSpawner`, `start`'s own
 * bring-up creates 10+ containers per scenario and never needs to exercise a
 * Docker-CLI-level race, so a synchronous mock keeps these tests fast.
 *
 * `failSpawn` mirrors `status.integration.test.ts`'s `failSpawnFor` — every
 * spawn attempt (both `docker` and its `podman` fallback) fails to even start,
 * distinct from a spawned process exiting non-zero.
 */
function mockStartContainerCliSpawner(
  route: (
    args: ReadonlyArray<string>,
  ) => RouteResult | Effect.Effect<RouteResult, PlatformError.PlatformError>,
  opts: {
    readonly failSpawn?: boolean;
    readonly onSecretCopy?: (containerPath: string, content: string) => void;
  } = {},
) {
  const spawned: Array<SpawnRecord> = [];
  const encoder = new TextEncoder();

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const cmd = command._tag === "StandardCommand" ? command.command : "";
        const args = command._tag === "StandardCommand" ? command.args : [];
        const env = command._tag === "StandardCommand" ? (command.options?.env ?? {}) : {};
        const stdin = command._tag === "StandardCommand" ? command.options.stdin : undefined;
        const onSecretCopy = opts.onSecretCopy;
        spawned.push({ command: cmd, args, env });

        if (opts.failSpawn === true) {
          return yield* PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "spawn failed",
          });
        }

        if (onSecretCopy !== undefined && args[0] === "cp" && args[1] === "-") {
          if (!Stream.isStream(stdin)) {
            return yield* Effect.die("docker cp - was spawned without an input stream");
          }
          const archiveBytes = concatByteChunks(yield* Stream.runCollect(stdin));
          if (archiveBytes === undefined) {
            return yield* Effect.die("docker cp stdin did not contain archive bytes");
          }
          const archiveFiles = yield* Effect.promise(() => new Bun.Archive(archiveBytes).files());
          for (const [path, file] of archiveFiles) {
            onSecretCopy(`/${path}`, yield* Effect.promise(() => file.text()));
          }
        }

        const response = route(args);
        const result = Effect.isEffect(response) ? yield* response : response;
        const stdoutBytes = (result.stdout ?? []).map((line) => encoder.encode(`${line}\n`));
        const stderrBytes = (result.stderr ?? []).map((line) => encoder.encode(`${line}\n`));
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(5000 + spawned.length),
          stdout: Stream.fromIterable(stdoutBytes),
          stderr: Stream.fromIterable(stderrBytes),
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode ?? 0)),
          isRunning: Effect.succeed(false),
          stdin: Sink.drain,
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );

  return {
    layer,
    get spawned() {
      return spawned;
    },
  };
}

const HEALTHY_STATE = '{"Running":true,"Status":"running","Health":{"Status":"healthy"}}';
const STARTING_STATE = '{"Running":true,"Status":"running","Health":{"Status":"starting"}}';
const STOPPED_STATE = '{"Running":false,"Status":"exited"}';
const CREATED_STATE = '{"Running":false,"Status":"created"}';

function containerNameFromCreateArgs(args: ReadonlyArray<string>): string {
  const nameIndex = args.indexOf("--name");
  return nameIndex !== -1 ? (args[nameIndex + 1] ?? "unknown") : "unknown";
}

/** Edge Runtime's own create/cp/start bring-up sits outside `createContainer`; its create is recognized by the `_edge_runtime_` container name. */
function isEdgeRuntimeCreate(args: ReadonlyArray<string>): boolean {
  return args[0] === "create" && containerNameFromCreateArgs(args).includes("_edge_runtime_");
}

/**
 * Real `docker create` prints a 64-hex id, never the `--name`. The mock does
 * too, so a caller that carries that opaque id into the health watch fails the
 * assertions here instead of shipping unreadable output to users.
 */
function fakeContainerId(name: string): string {
  return [...name]
    .map((char) => (char.codePointAt(0) ?? 0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);
}

function createdContainerNames(spawned: ReadonlyArray<SpawnRecord>): ReadonlyArray<string> {
  // Excludes Edge Runtime's create so this keeps meaning "which services
  // `createContainer` brought up", the premise of the exact-equality assertions below.
  return spawned
    .filter((s) => s.args[0] === "create" && !isEdgeRuntimeCreate(s.args))
    .map((s) => containerNameFromCreateArgs(s.args));
}

function rollbackWasAttempted(spawned: ReadonlyArray<SpawnRecord>): boolean {
  return spawned.some((s) => s.args[0] === "container" && s.args[1] === "prune");
}

/**
 * Stateful default route: only created containers inspect successfully,
 * mirroring Docker across initial state detection and post-create health waits.
 */
function defaultRoute(opts: { readonly neverHealthy?: ReadonlySet<string> } = {}) {
  const created = new Set<string>();
  return (args: ReadonlyArray<string>): RouteResult => {
    if (args[0] === "image" && args[1] === "inspect") return { exitCode: 0 };
    if (args[0] === "network" && args[1] === "inspect") return { exitCode: 1 };
    if (args[0] === "network" && args[1] === "create") return { exitCode: 0 };
    if (args[0] === "volume" && args[1] === "create") return { exitCode: 0 };
    if (args[0] === "context" && args[1] === "inspect") return { exitCode: 1 };
    if (args[0] === "create") {
      const name = containerNameFromCreateArgs(args);
      created.add(name);
      return { stdout: [fakeContainerId(name)] };
    }
    if (args[0] === "start") return { exitCode: 0 };
    if (args[0] === "container" && args[1] === "inspect") {
      const id = args[2] ?? "";
      if (!created.has(id)) {
        return { exitCode: 1, stderr: [`Error: No such container: ${id}`] };
      }
      if (opts.neverHealthy?.has(id) === true) return { stdout: [STARTING_STATE] };
      return { stdout: [HEALTHY_STATE] };
    }
    if (args[0] === "logs") return { exitCode: 0 };
    if (args[0] === "ps") return { stdout: [] };
    return { exitCode: 0 };
  };
}

/** A `HttpClient` that always answers 200 — the default config's PostgREST/Kong readiness probe. */
const alwaysReadyHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

/** Fails loudly if called — for scenarios that exclude/disable `postgrest` and must never reach HTTP. */
const unusedHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("HttpClient should not be called for this scenario")),
);

/** Overrides the default route's "volume already exists" answer to simulate a brand-new Postgres volume. */
function freshVolumeRoute(
  base: (
    args: ReadonlyArray<string>,
  ) => RouteResult | Effect.Effect<RouteResult, PlatformError.PlatformError>,
): (
  args: ReadonlyArray<string>,
) => RouteResult | Effect.Effect<RouteResult, PlatformError.PlatformError> {
  return (args) => {
    // This stderr text is what `volumeExists` treats as a confirmed missing volume.
    if (args[0] === "volume" && args[1] === "inspect") {
      return { exitCode: 1, stderr: [`Error: No such volume: ${args[2] ?? ""}`] };
    }
    return base(args);
  };
}

/**
 * Vector-capable variant: empty bucket list, a fixed set of existing vector buckets, and a
 * raw-body recorder for `DeleteVectorBucket` calls; every other request answers a bare 200.
 */
function mockStorageVectorHttpClient(existingVectorBuckets: ReadonlyArray<string>) {
  const deletedVectorBuckets: Array<string> = [];
  let vectorListCalls = 0;
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const json = (body: unknown) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      if (request.method === "GET" && request.url.includes("/storage/v1/bucket")) {
        return json([]);
      }
      if (
        request.method === "POST" &&
        request.url.includes("/storage/v1/vector/ListVectorBuckets")
      ) {
        vectorListCalls += 1;
        return json({
          vectorBuckets: existingVectorBuckets.map((name) => ({ vectorBucketName: name })),
        });
      }
      if (
        request.method === "POST" &&
        request.url.includes("/storage/v1/vector/DeleteVectorBucket")
      ) {
        deletedVectorBuckets.push(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        );
        return json({});
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
      );
    }),
  );
  return {
    layer,
    deletedVectorBuckets,
    get vectorListCalls() {
      return vectorListCalls;
    },
  };
}

/** Storage's `/storage/v1/bucket` GET (list)/POST (create) endpoints — every other request answers a bare 200, matching `alwaysReadyHttpClientLayer`'s permissiveness for the PostgREST/Edge Runtime readiness probes some scenarios also exercise. */
function mockStorageBucketHttpClient(existingBuckets: ReadonlyArray<string> = []) {
  const createdBucketRequests: Array<string> = [];
  const createdBucketBodies: Array<unknown> = [];
  const updatedBucketRequests: Array<string> = [];
  /** Every request in order, so a test can assert a readiness probe preceded seeding. */
  const requests: Array<{ method: string; url: string }> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push({ method: request.method, url: request.url });
      if (request.method === "GET" && request.url.includes("/storage/v1/bucket")) {
        const listed = JSON.stringify(existingBuckets.map((name) => ({ id: name, name })));
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(listed, {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      }
      if (request.method === "POST" && request.url.includes("/storage/v1/bucket")) {
        createdBucketRequests.push(request.url);
        if (request.body._tag === "Uint8Array") {
          try {
            createdBucketBodies.push(JSON.parse(new TextDecoder().decode(request.body.body)));
          } catch {
            createdBucketBodies.push(undefined);
          }
        } else {
          createdBucketBodies.push(undefined);
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ name: "avatars" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      }
      if (request.method === "PUT" && request.url.includes("/storage/v1/bucket/")) {
        updatedBucketRequests.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ message: "Successfully updated" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
      );
    }),
  );
  return { layer, createdBucketRequests, createdBucketBodies, updatedBucketRequests, requests };
}

/**
 * A fake `DbSession` recording every `exec`/`query` call — needed for PG<=14's schema SQL /
 * `ApplyApiPrivileges` path; PG15+ (this suite's default) never calls `exec`/`query` at all (its
 * schema init is three one-shot `DockerRun` jobs instead), so this mostly just needs to exist
 * and satisfy the type.
 */
function fakeDbSession() {
  const calls: Array<{ kind: "exec" | "query"; sql: string }> = [];
  const session: DbSession = {
    exec: (sql) =>
      Effect.sync(() => {
        calls.push({ kind: "exec", sql });
      }),
    query: (sql) =>
      Effect.sync(() => {
        calls.push({ kind: "query", sql });
        return [];
      }),
    execBatch: (statements) => sequentialExecBatch(session)(statements),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, calls };
}

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  /** Piped stdin for the seeding confirmations; `start` must never consume it. */
  readonly stdinInput?: string;
  readonly route?: (
    args: ReadonlyArray<string>,
  ) => RouteResult | Effect.Effect<RouteResult, PlatformError.PlatformError>;
  /** Observes files decoded from the in-memory tar stream passed to `docker cp -`. */
  readonly onSecretCopy?: (containerPath: string, content: string) => void;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly configuredProjectId?: string;
  /** Raw `config.toml` contents — overrides `configuredProjectId`'s single-line default. */
  readonly configContents?: string;
  /** Skip writing `config.toml` entirely — the test writes its own (e.g. a malformed file). */
  readonly skipConfig?: boolean;
  /** Every spawn attempt (docker and its podman fallback) fails outright — neither runtime found. */
  readonly failSpawn?: boolean;
  /** Defaults to `tempRoot.current` — override for `--workdir`-resolution failure tests. */
  readonly workdir?: string;
  /** `--network-id` override. Defaults to unset (the generated `supabase_network_<project>` name applies). */
  readonly networkId?: Option.Option<string>;
  /** `--experimental`/`SUPABASE_EXPERIMENTAL`. Defaults to `false`. */
  readonly experimental?: boolean;
}

const setup = Effect.fnUntraced(function* (opts: SetupOpts = {}) {
  const workdir = opts.workdir ?? tempRoot.current;
  if (opts.skipConfig !== true) {
    yield* writeConfig(
      workdir,
      opts.configContents ?? `project_id = "${opts.configuredProjectId ?? "demo"}"\n`,
    );
  }
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockTelemetryStateTracked();
  const analytics = mockAnalytics();
  const startContainerEnvValues = yield* resolveStartContainerEnvValues().pipe(
    Effect.provide(cliConfigProviderLayer),
  );
  const cliSettings = mockCommandSettings({ workdir, startContainerEnvValues });
  const child = mockStartContainerCliSpawner(opts.route ?? defaultRoute(), {
    failSpawn: opts.failSpawn,
    onSecretCopy: opts.onSecretCopy,
  });
  const dbSession = fakeDbSession();
  const layer = Layer.mergeAll(
    BunServices.layer,
    out.layer,
    cliSettings,
    telemetry.layer,
    analytics.layer,
    child.layer,
    opts.httpClientLayer ?? alwaysReadyHttpClientLayer,
    // Only exercised by a fresh-volume scenario; every other scenario's default route never
    // reaches `startSetupLocalDatabase`/`seedBucketsRun`, but both are part of `start`'s
    // aggregate Effect type, so every scenario still needs this satisfied.
    Layer.succeed(DbConnection, { connect: () => Effect.succeed(dbSession.session) }),
    // `Layer.mergeAll` never cross-wires sibling requirements, so `dockerRunLayer` needs
    // `ChildProcessSpawner`/`ProcessControl` provided to it explicitly, not just present
    // elsewhere in this merge.
    dockerRunLayer.pipe(Layer.provide(child.layer), Layer.provide(mockProcessControl().layer)),
    mockProcessControl().layer,
    mockRuntimeInfo({ platform: "linux" }),
    Layer.succeed(CommandPlatformApiFactory, {
      make: Effect.die("CommandPlatformApiFactory should not be used by a local start"),
    }),
    Layer.succeed(CliArgs, { args: ["start"] }),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(YesFlag, false),
    Layer.succeed(ExperimentalFlag, opts.experimental ?? false),
    Layer.succeed(NetworkIdFlag, opts.networkId ?? Option.none()),
    mockTty({ stdinIsTty: false }),
    mockStdin(false, opts.stdinInput),
  );
  return { workdir, out, telemetry, analytics, child, dbSession, layer };
});

/**
 * Maps each of the 13 valid `--exclude` keys to the container-name suffix(es) that key skips,
 * for the parameterized exclusion matrix test below. `storage-api` is compound: excluding it
 * also disables ImgProxy. `edge-runtime` maps to no suffix here — it still starts via its own
 * create/cp/start bring-up outside `createContainer` (which `createdContainerNames` excludes),
 * so it's covered by its own dedicated scenarios below instead of this `docker create`-based matrix.
 */
const CONTAINER_SUFFIX_BY_EXCLUDE_KEY: Readonly<Record<string, string>> = {
  gotrue: "auth",
  realtime: "realtime",
  "storage-api": "storage",
  imgproxy: "imgproxy",
  kong: "kong",
  mailpit: "inbucket",
  postgrest: "rest",
  "postgres-meta": "pg_meta",
  studio: "studio",
  "edge-runtime": "",
  logflare: "analytics",
  vector: "vector",
  supavisor: "pooler",
};

/** Every container suffix a clean host creates when nothing is excluded, given a config that turns on ImgProxy + the pooler (see the matrix test's own config). */
const ALL_EXCLUDABLE_SUFFIXES: ReadonlyArray<string> = [
  "kong",
  "auth",
  "inbucket",
  "realtime",
  "rest",
  "storage",
  "imgproxy",
  "pg_meta",
  "studio",
  "analytics",
  "vector",
  "pooler",
];

function missingSuffixesForExcludeKey(excludeKey: string): ReadonlyArray<string> {
  if (excludeKey === "edge-runtime") return [];
  if (excludeKey === "storage-api") {
    return [
      CONTAINER_SUFFIX_BY_EXCLUDE_KEY["storage-api"]!,
      CONTAINER_SUFFIX_BY_EXCLUDE_KEY.imgproxy!,
    ];
  }
  return [CONTAINER_SUFFIX_BY_EXCLUDE_KEY[excludeKey]!];
}

// This ciphertext decrypts to "value" under the keypair below (same fixture as
// `local-config-values.unit.test.ts`'s "encrypted auth secrets" suite).
const VAULT_PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
const VAULT_ENCRYPTED =
  "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";

describe("start integration", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("--exclude validation", () => {
    it.live("warns on stderr for an invalid --exclude value, even when already running", () =>
      Effect.gen(function* () {
        const { layer, out } = yield* setup({
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              return { stdout: [HEALTHY_STATE] };
            }
            if (args[0] === "ps") return { stdout: [] };
            return { exitCode: 0 };
          },
        });

        yield* start(flags({ exclude: ["not-a-real-service"] })).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("WARNING:");
        expect(out.stderrText).toContain("not-a-real-service");
        expect(out.stderrText).toContain("not valid to exclude");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "rejects --exclude db and --exclude postgres as invalid, since Postgres has no exclude key",
      () =>
        Effect.gen(function* () {
          const { layer, out, child } = yield* setup();

          yield* start(flags({ exclude: ["db", "postgres"] })).pipe(Effect.provide(layer));
          expect(out.stderrText).toContain("WARNING:");
          expect(out.stderrText).toContain("db, postgres");
          expect(out.stderrText).toContain("not valid to exclude");
          expect(createdContainerNames(child.spawned).some((name) => name.includes("_db_"))).toBe(
            true,
          );
        }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("already running", () => {
    it.live(
      "prints the already-running banner and renders status without creating any containers",
      () =>
        Effect.gen(function* () {
          const { layer, out, child } = yield* setup({
            route: (args) => {
              if (args[0] === "container" && args[1] === "inspect") {
                return { stdout: [HEALTHY_STATE] };
              }
              if (args[0] === "ps") return { stdout: [] };
              return { exitCode: 0 };
            },
          });

          yield* start(flags()).pipe(Effect.provide(layer));
          expect(out.stderrText).toContain("supabase start");
          expect(out.stderrText).toContain("is already running");
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("reports the stack is already running with a machine payload in json mode", () =>
      Effect.gen(function* () {
        const { layer, out } = yield* setup({
          format: "json",
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              return { stdout: [HEALTHY_STATE] };
            }
            if (args[0] === "ps") return { stdout: [] };
            return { exitCode: 0 };
          },
        });

        yield* start(flags()).pipe(Effect.provide(layer));
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.data).toMatchObject({ DB_URL: expect.any(String) });
        expect(out.stderrText).not.toContain("is already running");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("reports the stack is already running with a machine payload in stream-json mode", () =>
      Effect.gen(function* () {
        const { layer, out } = yield* setup({
          format: "stream-json",
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              return { stdout: [HEALTHY_STATE] };
            }
            if (args[0] === "ps") return { stdout: [] };
            return { exitCode: 0 };
          },
        });

        yield* start(flags()).pipe(Effect.provide(layer));
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.data).toMatchObject({ DB_URL: expect.any(String) });
        expect(out.stderrText).not.toContain("is already running");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails when the already-running DB container stops running before the health re-check",
      () =>
        Effect.gen(function* () {
          let inspectCalls = 0;
          const { layer, child } = yield* setup({
            route: (args) => {
              if (args[0] === "container" && args[1] === "inspect") {
                inspectCalls += 1;
                if (inspectCalls === 1) return { stdout: [HEALTHY_STATE] };
                return { stdout: [JSON.stringify({ Status: "exited", Running: false })] };
              }
              return { exitCode: 0 };
            },
          });

          const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("StatusDbNotRunningError");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("fails when the already-running DB container is unhealthy on the health re-check", () =>
      Effect.gen(function* () {
        let inspectCalls = 0;
        const { layer } = yield* setup({
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              inspectCalls += 1;
              if (inspectCalls === 1) return { stdout: [HEALTHY_STATE] };
              return { stdout: [STARTING_STATE] };
            }
            return { exitCode: 0 };
          },
        });

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("StatusDbNotReadyError");
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails when the already-running DB container's health re-check inspect itself errors",
      () =>
        Effect.gen(function* () {
          let inspectCalls = 0;
          const { layer } = yield* setup({
            route: (args) => {
              if (args[0] === "container" && args[1] === "inspect") {
                inspectCalls += 1;
                if (inspectCalls === 1) return { stdout: [HEALTHY_STATE] };
                return { exitCode: 1, stderr: ["permission denied"] };
              }
              return { exitCode: 0 };
            },
          });

          const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = Cause.pretty(exit.cause);
            expect(serialized).toContain("StatusDbInspectError");
            expect(serialized).toContain("permission denied");
          }
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("fails when listing running containers errors while already running", () =>
      Effect.gen(function* () {
        const { layer } = yield* setup({
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              return { stdout: [HEALTHY_STATE] };
            }
            if (args[0] === "ps") return { exitCode: 1, stderr: ["daemon down"] };
            return { exitCode: 0 };
          },
        });

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("StatusListError");
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("already running, --ignore-health-check skips the health re-check entirely", () =>
      Effect.gen(function* () {
        let inspectCalls = 0;
        const { layer, child } = yield* setup({
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              inspectCalls += 1;
              if (inspectCalls === 1) return { stdout: [HEALTHY_STATE] };
              return { exitCode: 1, stderr: ["should not be called"] };
            }
            if (args[0] === "ps") return { stdout: [] };
            return { exitCode: 0 };
          },
        });

        yield* start(flags({ ignoreHealthCheck: true })).pipe(Effect.provide(layer));
        expect(inspectCalls).toBe(1);
        expect(child.spawned.some((s) => s.args[0] === "ps")).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("already running with every service still up omits the 'Stopped services' line", () =>
      Effect.gen(function* () {
        const { layer, out } = yield* setup({
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              return { stdout: [HEALTHY_STATE] };
            }
            if (args[0] === "ps") return { stdout: [...serviceContainerIds("demo")] };
            return { exitCode: 0 };
          },
        });

        yield* start(flags()).pipe(Effect.provide(layer));
        expect(out.stderrText).not.toContain("Stopped services");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on a bucket's invalid file_size_limit even when already running, matching Go's Config.Load",
      () =>
        Effect.gen(function* () {
          const { layer, child } = yield* setup({
            configContents:
              'project_id = "demo"\n[storage.buckets.avatars]\nfile_size_limit = "bogus"\n',
            route: (args) => {
              if (args[0] === "container" && args[1] === "inspect") {
                return { stdout: [HEALTHY_STATE] };
              }
              if (args[0] === "ps") return { stdout: [] };
              return { exitCode: 0 };
            },
          });

          const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = Cause.pretty(exit.cause);
            expect(serialized).toContain("DbConfigLoadError");
            expect(serialized).toContain(
              "failed to parse config: invalid storage.buckets.avatars.file_size_limit.",
            );
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("stopped project recovery", () => {
    it.live("recreates stopped project containers without pruning the database volume", () =>
      Effect.gen(function* () {
        const workdir = tempRoot.current;
        const route = defaultRoute();
        let recovering = false;
        const { layer, out, child } = yield* setup({
          route: (args) => {
            if (
              args[0] === "container" &&
              args[1] === "inspect" &&
              args[2] === "supabase_db_demo" &&
              !recovering
            ) {
              return { stdout: [STOPPED_STATE] };
            }
            if (args[0] === "ps" && args.includes("--all")) {
              recovering = true;
              return {
                stdout: [
                  `db-id\tsupabase_db_demo\t${workdir}`,
                  `kong-id\tsupabase_kong_demo\t${workdir}`,
                ],
              };
            }
            return route(args);
          },
        });

        yield* start(flags()).pipe(Effect.provide(layer));

        expect(out.stderrText).not.toContain("is already running");
        expect(createdContainerNames(child.spawned)).toContain("supabase_db_demo");
        expect(
          child.spawned
            .filter((spawn) => spawn.args[0] === "stop")
            .map((spawn) => spawn.args[1])
            .sort((left, right) => (left ?? "").localeCompare(right ?? "")),
        ).toEqual(["db-id", "kong-id"]);
        expect(
          child.spawned.some(
            (spawn) =>
              spawn.args[0] === "ps" &&
              spawn.args.includes("--all") &&
              spawn.args.includes("label=com.supabase.cli.project=demo"),
          ),
        ).toBe(true);
        expect(
          child.spawned.some(
            (spawn) =>
              spawn.args[0] === "container" &&
              spawn.args[1] === "prune" &&
              spawn.args.includes("label=com.supabase.cli.project=demo"),
          ),
        ).toBe(true);
        expect(
          child.spawned.some(
            (spawn) =>
              spawn.args[0] === "network" &&
              spawn.args[1] === "prune" &&
              spawn.args.includes("label=com.supabase.cli.project=demo"),
          ),
        ).toBe(true);
        expect(
          child.spawned.some((spawn) => spawn.args[0] === "volume" && spawn.args[1] === "prune"),
        ).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not remove containers when the project id sanitizes to empty", () =>
      Effect.gen(function* () {
        const { layer, child } = yield* setup({
          configContents: 'project_id = "!!!"\n',
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect" && args[2] === "supabase_db_") {
              return { stdout: [STOPPED_STATE] };
            }
            return { exitCode: 0 };
          },
        });

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("StartInvalidConfigError");
        }
        expect(
          child.spawned.some(
            (spawn) =>
              (spawn.args[0] === "ps" && spawn.args.includes("--all")) || spawn.args[1] === "prune",
          ),
        ).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("preserves a stopped Bitbucket database container", () =>
      withEnvVar(
        "BITBUCKET_CLONE_DIR",
        "/opt/atlassian/pipelines/agent/build",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup({
              route: (args) => {
                if (args[0] === "container" && args[1] === "inspect") {
                  return { stdout: [STOPPED_STATE] };
                }
                return { exitCode: 0 };
              },
            });

            const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(Cause.pretty(exit.cause)).toContain("StatusDbNotRunningError");
            }
            expect(
              child.spawned.some(
                (spawn) =>
                  (spawn.args[0] === "ps" && spawn.args.includes("--all")) ||
                  spawn.args[0] === "stop" ||
                  spawn.args[1] === "prune" ||
                  spawn.args[0] === "create",
              ),
            ).toBe(false);
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not remove containers when re-inspect returns an unknown state", () =>
      Effect.gen(function* () {
        let dbInspects = 0;
        const { layer, child } = yield* setup({
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              dbInspects += 1;
              return { stdout: [dbInspects === 1 ? STOPPED_STATE : ""] };
            }
            return { exitCode: 0 };
          },
        });

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(
          child.spawned.some(
            (spawn) =>
              (spawn.args[0] === "ps" && spawn.args.includes("--all")) || spawn.args[1] === "prune",
          ),
        ).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("does not recover a created database container with unknown volume state", () =>
      Effect.gen(function* () {
        const { layer, child } = yield* setup({
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              return { stdout: [CREATED_STATE] };
            }
            return { exitCode: 0 };
          },
        });

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = Cause.pretty(exit.cause);
          expect(serialized).toContain("StatusDbNotRunningError");
          expect(serialized).toContain("container is not running: created");
        }
        expect(
          child.spawned.some(
            (spawn) =>
              (spawn.args[0] === "ps" && spawn.args.includes("--all")) ||
              spawn.args[0] === "stop" ||
              spawn.args[1] === "prune" ||
              spawn.args[0] === "create",
          ),
        ).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("validates custom TLS files before removing a stopped stack", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const workdir = tempRoot.current;
        const certPath = path.join(workdir, "supabase", "certs", "server.crt");
        const keyPath = path.join(workdir, "supabase", "certs", "server.key");
        yield* fs.makeDirectory(path.join(workdir, "supabase", "certs"), { recursive: true });
        yield* fs.writeFileString(certPath, "-----BEGIN CERTIFICATE-----");
        yield* fs.writeFileString(keyPath, "-----BEGIN PRIVATE KEY-----");
        const { layer, child } = yield* setup({
          configContents:
            'project_id = "demo"\n[api.tls]\nenabled = true\ncert_path = "certs/server.crt"\nkey_path = "certs/server.key"\n',
          route: (args) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              if (args[0] === "container" && args[1] === "inspect") {
                if (yield* fs.exists(certPath)) yield* fs.remove(certPath);
                return { stdout: [STOPPED_STATE] };
              }
              return { exitCode: 0 };
            }).pipe(Effect.provide(BunServices.layer)),
        });

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = Cause.pretty(exit.cause);
          expect(serialized).toContain("StartInvalidConfigError");
          expect(serialized).toContain("failed to read TLS cert");
        }
        expect(
          child.spawned.some(
            (spawn) =>
              (spawn.args[0] === "ps" && spawn.args.includes("--all")) ||
              spawn.args[0] === "stop" ||
              spawn.args[1] === "prune" ||
              spawn.args[0] === "create",
          ),
        ).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("validates function bind mounts before removing a stopped stack", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const workdir = tempRoot.current;
        const entrypointPath = path.join(workdir, "supabase", "functions", "foo", "index.ts");
        yield* fs.makeDirectory(path.join(workdir, "supabase", "functions", "foo"), {
          recursive: true,
        });
        yield* fs.writeFileString(entrypointPath, "export {};\n");
        const { layer, child } = yield* setup({
          configContents:
            'project_id = "demo"\n[functions.foo]\nentrypoint = "./functions/foo/index.ts"\n',
          route: (args) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              if (args[0] === "container" && args[1] === "inspect") {
                if (yield* fs.exists(entrypointPath)) yield* fs.remove(entrypointPath);
                return { stdout: [STOPPED_STATE] };
              }
              return { exitCode: 0 };
            }).pipe(Effect.provide(BunServices.layer)),
        });

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(
          child.spawned.some(
            (spawn) =>
              (spawn.args[0] === "ps" && spawn.args.includes("--all")) ||
              spawn.args[0] === "stop" ||
              spawn.args[1] === "prune" ||
              spawn.args[0] === "create",
          ),
        ).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("removes remaining project containers when the stopped database disappears", () =>
      Effect.gen(function* () {
        const workdir = tempRoot.current;
        const route = defaultRoute();
        let dbInspects = 0;
        const { layer, child } = yield* setup({
          route: (args) => {
            if (
              args[0] === "container" &&
              args[1] === "inspect" &&
              args[2] === "supabase_db_demo"
            ) {
              dbInspects += 1;
              if (dbInspects === 1) return { stdout: [STOPPED_STATE] };
              if (dbInspects === 2) {
                return {
                  exitCode: 1,
                  stderr: ["Error: No such container: supabase_db_demo"],
                };
              }
            }
            if (args[0] === "ps" && args.includes("--all")) {
              return { stdout: [`kong-id\tsupabase_kong_demo\t${workdir}`] };
            }
            return route(args);
          },
        });

        yield* start(flags()).pipe(Effect.provide(layer));

        expect(createdContainerNames(child.spawned)).toContain("supabase_db_demo");
        expect(
          child.spawned.filter((spawn) => spawn.args[0] === "stop").map((spawn) => spawn.args[1]),
        ).toEqual(["kong-id"]);
        expect(
          child.spawned.some(
            (spawn) =>
              spawn.args[0] === "container" &&
              spawn.args[1] === "prune" &&
              spawn.args.includes("label=com.supabase.cli.project=demo"),
          ),
        ).toBe(true);
        expect(
          child.spawned.some(
            (spawn) =>
              spawn.args[0] === "network" &&
              spawn.args[1] === "prune" &&
              spawn.args.includes("label=com.supabase.cli.project=demo"),
          ),
        ).toBe(true);
        expect(
          child.spawned.some((spawn) => spawn.args[0] === "volume" && spawn.args[1] === "prune"),
        ).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("cleans only current-workdir secrets when recovery fails", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const workdir = tempRoot.current;
        const staleSecretDir = path.join(
          workdir,
          "supabase",
          ".temp",
          "start-secrets",
          "supabase_db_demo",
        );
        const staleSecret = path.join(staleSecretDir, "stale-secret");
        yield* fs.makeDirectory(staleSecretDir, { recursive: true });
        yield* fs.writeFileString(staleSecret, "stale");
        const foreignWorkdir = path.join(workdir, "foreign");
        const foreignSecretDir = path.join(
          foreignWorkdir,
          "supabase",
          ".temp",
          "start-secrets",
          "supabase_kong_demo",
        );
        const foreignSecret = path.join(foreignSecretDir, "stale-secret");
        yield* fs.makeDirectory(foreignSecretDir, { recursive: true });
        yield* fs.writeFileString(foreignSecret, "foreign");
        const { layer, child } = yield* setup({
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              return { stdout: [STOPPED_STATE] };
            }
            if (args[0] === "ps" && args.includes("--all")) {
              return {
                stdout: [
                  `db-id\tsupabase_db_demo\t${workdir}`,
                  `kong-id\tsupabase_kong_demo\t${foreignWorkdir}`,
                ],
              };
            }
            if (args[0] === "network" && args[1] === "prune") {
              return { exitCode: 1 };
            }
            return { exitCode: 0 };
          },
        });

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("DockerRemoveAllNetworkPruneError");
        }
        expect(yield* fs.exists(staleSecret)).toBe(false);
        expect(yield* fs.exists(foreignSecret)).toBe(true);
        expect(createdContainerNames(child.spawned)).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("keeps a stopped stack intact when a later config field fails to parse", () =>
      Effect.gen(function* () {
        const { layer, child } = yield* setup({
          configContents: 'project_id = "demo"\n[db]\nhealth_timeout = "not-a-duration"\n',
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              return { stdout: [STOPPED_STATE] };
            }
            return { exitCode: 0 };
          },
        });

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("StartInvalidConfigError");
        }
        expect(
          child.spawned.some(
            (spawn) =>
              (spawn.args[0] === "ps" && spawn.args.includes("--all")) || spawn.args[1] === "prune",
          ),
        ).toBe(false);
        expect(child.spawned.some((spawn) => spawn.args[0] === "stop")).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("reports status instead of tearing down when the stack recovers before teardown", () =>
      Effect.gen(function* () {
        let dbInspects = 0;
        const { layer, out, child } = yield* setup({
          route: (args) => {
            if (
              args[0] === "container" &&
              args[1] === "inspect" &&
              args[2] === "supabase_db_demo"
            ) {
              dbInspects += 1;
              return { stdout: [dbInspects === 1 ? STOPPED_STATE : HEALTHY_STATE] };
            }
            if (args[0] === "ps") {
              return { stdout: ["supabase_db_demo"] };
            }
            return { exitCode: 0 };
          },
        });

        yield* start(flags()).pipe(Effect.provide(layer));

        expect(out.stderrText).toContain("is already running");
        expect(
          child.spawned.some(
            (spawn) =>
              (spawn.args[0] === "ps" && spawn.args.includes("--all")) || spawn.args[1] === "prune",
          ),
        ).toBe(false);
        expect(child.spawned.some((spawn) => spawn.args[0] === "stop")).toBe(false);
        expect(createdContainerNames(child.spawned)).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("config load / validation failures", () => {
    it.live("fails when --workdir/SUPABASE_WORKDIR points at a missing path", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const missingWorkdir = path.join(tempRoot.current, "does-not-exist");
        const { layer, child } = yield* setup({ workdir: missingWorkdir, skipConfig: true });

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = Cause.pretty(exit.cause);
          expect(serialized).toContain("StartWorkdirError");
          expect(serialized).toContain(
            `failed to change workdir: chdir ${missingWorkdir}: no such file or directory`,
          );
        }
        expect(child.spawned).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("fails when the DB container inspect fails for a reason other than not-found", () =>
      Effect.gen(function* () {
        const { layer, child } = yield* setup({
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              return { exitCode: 1, stderr: ["Error response from daemon: permission denied"] };
            }
            return { exitCode: 0 };
          },
        });

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = Cause.pretty(exit.cause);
          expect(serialized).toContain("DockerLifecycleInspectError");
          expect(serialized).toContain("permission denied");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails with a docker-unavailable error when neither docker nor podman can be spawned",
      () =>
        Effect.gen(function* () {
          const { layer } = yield* setup({ failSpawn: true });

          const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = Cause.pretty(exit.cause);
            expect(serialized).toContain("DockerLifecycleInspectError");
            expect(serialized).toContain("docker: command not found (podman also not found)");
            expect(classifyCliCauseActionability(exit.cause)).toMatchObject({
              error_kind: "user_actionable",
              error_category: "docker_not_running",
              error_fingerprint: "tag:DockerLifecycleInspectError:docker_not_running",
            });
          }
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("fails on a malformed config.toml", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = tempRoot.current;
        yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "config.toml"),
          "not valid toml =====",
        );
        const { layer, child } = yield* setup({ skipConfig: true });

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("StartConfigLoadError");
        }
        expect(child.spawned).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("fails when auth.jwt_secret is configured but shorter than 16 characters", () =>
      Effect.gen(function* () {
        const { layer, child } = yield* setup({
          configContents: 'project_id = "demo"\n[auth]\njwt_secret = "too-short"\n',
        });

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = Cause.pretty(exit.cause);
          expect(serialized).toContain("StartInvalidConfigError");
          expect(serialized).toContain(
            "Invalid config for auth.jwt_secret. Must be at least 16 characters",
          );
        }
        expect(child.spawned).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "rejects an out-of-root auth.email.template content_path before any Docker work, even with auth disabled",
      () =>
        Effect.gen(function* () {
          const { layer, child } = yield* setup({
            configContents:
              'project_id = "demo"\n[auth]\nenabled = false\n[auth.email.template.invite]\ncontent_path = "/etc/hosts"\n',
          });

          const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = Cause.pretty(exit.cause);
            expect(serialized).toContain("StartInvalidConfigError");
            // The message echoes the declared content_path (quoted), not the canonicalized
            // target — a recon-leak mitigation; see `resolveEmailTemplateContentPath`'s doc comment.
            expect(serialized).toContain(
              'Invalid config for auth.email.template.invite.content_path: "/etc/hosts" resolves outside the project root',
            );
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on a missing (but in-root) auth.email.template content_path before any Docker work, even with auth disabled",
      () =>
        Effect.gen(function* () {
          const { layer, workdir, child } = yield* setup({
            configContents:
              'project_id = "demo"\n[auth]\nenabled = false\n[auth.email.template.invite]\ncontent_path = "./templates/missing.html"\n',
          });

          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = Cause.pretty(exit.cause);
            expect(serialized).toContain("StartInvalidConfigError");
            expect(serialized).toContain(
              "Invalid config for auth.email.template.invite.content_path:",
            );
            // This content_path never escapes the project root, so a regression back to "no
            // read-verification" would make this succeed instead of fail.
            const failure = Cause.findErrorOption(exit.cause);
            expect(
              Option.isSome(failure) &&
                Predicate.isTagged(failure.value, "StartInvalidConfigError"),
            ).toBe(true);
            if (
              Option.isSome(failure) &&
              Predicate.isTagged(failure.value, "StartInvalidConfigError")
            ) {
              expect(failure.value.message).not.toContain("resolves outside the project root");
            }
          }
          expect(yield* fs.exists(path.join(workdir, "templates", "missing.html"))).toBe(false);
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("happy path", () => {
    it.live(
      "brings up the full default stack (clean host, every container immediately healthy)",
      () =>
        Effect.gen(function* () {
          const { layer, out, child, analytics } = yield* setup();

          yield* start(flags()).pipe(Effect.provide(layer));

          const createdNames = createdContainerNames(child.spawned);
          // Postgres + the 10 excludable services enabled by default
          // (imgproxy/supavisor stay off: `storage.image_transformation.enabled`/
          // `db.pooler.enabled` both default `false`).
          expect(createdNames.filter((name) => name.includes("_db_"))).toHaveLength(1);
          expect(createdNames.filter((name) => name.includes("_kong_"))).toHaveLength(1);
          expect(createdNames.filter((name) => name.includes("_auth_"))).toHaveLength(1);
          expect(createdNames.filter((name) => name.includes("_inbucket_"))).toHaveLength(1);
          expect(createdNames.filter((name) => name.includes("_realtime_"))).toHaveLength(1);
          expect(createdNames.filter((name) => name.includes("_rest_"))).toHaveLength(1);
          expect(createdNames.filter((name) => name.includes("_storage_"))).toHaveLength(1);
          expect(createdNames.filter((name) => name.includes("_analytics_"))).toHaveLength(1);
          expect(createdNames.filter((name) => name.includes("_vector_"))).toHaveLength(1);
          expect(createdNames.filter((name) => name.includes("_pg_meta_"))).toHaveLength(1);
          expect(createdNames.filter((name) => name.includes("_studio_"))).toHaveLength(1);
          expect(createdNames.some((name) => name.includes("_imgproxy_"))).toBe(false);
          expect(createdNames.some((name) => name.includes("_pooler_"))).toBe(false);

          expect(out.stderrText).toContain("Starting containers...");
          expect(out.stderrText).toContain("Waiting for health checks...");
          expect(out.stderrText).toContain("Started");
          expect(out.stderrText).toContain("local development setup.");
          expect(analytics.captured).toContainEqual(
            expect.objectContaining({ event: "cli_stack_started" }),
          );
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("emits a machine status payload in json mode instead of the pretty table", () =>
      Effect.gen(function* () {
        const { layer, out } = yield* setup({ format: "json" });

        yield* start(flags()).pipe(Effect.provide(layer));
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.data).toMatchObject({ DB_URL: expect.any(String) });
        expect(out.stderrText).not.toContain("Started");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("emits a machine status payload in stream-json mode instead of the pretty table", () =>
      Effect.gen(function* () {
        const { layer, out } = yield* setup({ format: "stream-json" });

        yield* start(flags()).pipe(Effect.provide(layer));
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.data).toMatchObject({ DB_URL: expect.any(String) });
        expect(out.stderrText).not.toContain("Started");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("fires cli_stack_started exactly once on a successful start", () =>
      Effect.gen(function* () {
        const { layer, analytics } = yield* setup();

        yield* start(flags()).pipe(Effect.provide(layer));
        const stackStartedEvents = analytics.captured.filter(
          (c) => c.event === "cli_stack_started",
        );
        expect(stackStartedEvents).toEqual([{ event: "cli_stack_started", properties: {} }]);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("brings the stack up when podman rejects re-creating preserved volumes (#6020)", () =>
      Effect.gen(function* () {
        const route = defaultRoute();
        const { layer, analytics } = yield* setup({
          route: (args) => {
            if (args[0] === "volume" && args[1] === "create") {
              const name = args[args.length - 1] ?? "";
              return {
                exitCode: 125,
                stderr: [`Error: volume with name ${name} already exists: volume already exists`],
              };
            }
            return route(args);
          },
        });

        yield* start(flags()).pipe(Effect.provide(layer));
        expect(analytics.captured.some((c) => c.event === "cli_stack_started")).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "reuses the bring-up-resolved local config values for the final status print instead of re-deriving them",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { layer, workdir } = yield* setup({
            format: "json",
            configContents:
              'project_id = "demo"\n[auth]\nsigning_keys_path = "signing_keys.json"\n',
          });
          const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
          const jwk = { ...privateKey.export({ format: "jwk" }), alg: "RS256", kid: "test-kid" };
          yield* fs.writeFileString(
            path.join(workdir, "supabase", "signing_keys.json"),
            yield* Schema.encodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Array(
                  Schema.Struct({
                    kty: Schema.Literal("RSA"),
                    alg: Schema.Literal("RS256"),
                    kid: Schema.String,
                    n: Schema.String,
                    e: Schema.String,
                    d: Schema.String,
                    p: Schema.String,
                    q: Schema.String,
                    dp: Schema.String,
                    dq: Schema.String,
                    qi: Schema.String,
                  }),
                ),
              ),
            )([jwk]),
          );
          resolveLocalConfigValuesCalls.count = 0;

          yield* start(flags()).pipe(Effect.provide(layer));
          expect(resolveLocalConfigValuesCalls.count).toBe(1);
        }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("config-driven container-spec branches", () => {
    it.live("fails when a configured third-party auth issuer returns an HTTP error", () =>
      Effect.gen(function* () {
        const { layer, child } = yield* setup({
          httpClientLayer: Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
              ),
            ),
          ),
          configContents:
            'project_id = "demo"\n[auth.third_party.firebase]\nenabled = true\nproject_id = "fb-project"\n',
        });

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("StartInvalidConfigError");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("reads and mounts a configured API TLS cert/key pair for Kong", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { layer, workdir, child } = yield* setup({
          configContents:
            'project_id = "demo"\n[api.tls]\nenabled = true\ncert_path = "certs/server.crt"\nkey_path = "certs/server.key"\n',
        });
        yield* fs.makeDirectory(path.join(workdir, "supabase", "certs"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "certs", "server.crt"),
          "-----BEGIN CERTIFICATE-----",
        );
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "certs", "server.key"),
          "-----BEGIN PRIVATE KEY-----",
        );

        yield* start(flags()).pipe(Effect.provide(layer));
        expect(createdContainerNames(child.spawned).some((name) => name.includes("_kong_"))).toBe(
          true,
        );
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("fails when a configured API TLS cert file cannot be read", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { layer, workdir, child } = yield* setup({
          configContents:
            'project_id = "demo"\n[api.tls]\nenabled = true\ncert_path = "certs/server.crt"\nkey_path = "certs/server.key"\n',
        });
        yield* fs.makeDirectory(path.join(workdir, "supabase", "certs"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "certs", "server.key"),
          "-----BEGIN PRIVATE KEY-----",
        );

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = Cause.pretty(exit.cause);
          expect(serialized).toContain("StartInvalidConfigError");
          expect(serialized).toContain("failed to read TLS cert");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("fails when a configured API TLS key file cannot be read", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { layer, workdir, child } = yield* setup({
          configContents:
            'project_id = "demo"\n[api.tls]\nenabled = true\ncert_path = "certs/server.crt"\nkey_path = "certs/server.key"\n',
        });
        yield* fs.makeDirectory(path.join(workdir, "supabase", "certs"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "certs", "server.crt"),
          "-----BEGIN CERTIFICATE-----",
        );

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = Cause.pretty(exit.cause);
          expect(serialized).toContain("StartInvalidConfigError");
          expect(serialized).toContain("failed to read TLS key");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "brings up the stack with every optional config.toml section populated (bigquery analytics, session pool mode, passkey/webauthn, external provider, SMTP, email templates)",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { layer, workdir, child } = yield* setup({
            configContents: `project_id = "demo"

[analytics]
backend = "bigquery"
gcp_project_id = "gcp-project"
gcp_project_number = "123456789"
gcp_jwt_path = "gcp-key.json"

[db.pooler]
enabled = true
pool_mode = "session"

[auth.passkey]
enabled = true

[auth.webauthn]
rp_id = "localhost"
rp_display_name = "Test App"
rp_origins = ["http://localhost:3000"]

[auth.external.github]
enabled = true
client_id = "gh-client-id"
secret = "gh-secret"

[auth.email.smtp]
enabled = true
host = "smtp.example.com"
port = 587
user = "smtp-user"
pass = "smtp-pass"
admin_email = "admin@example.com"

[auth.email.template.confirmation]
content_path = "./supabase/templates/confirmation.html"

[auth.email.notification.custom_notice]
enabled = true
content_path = "./supabase/templates/custom_notice.html"
`,
          });
          // `Config.Validate` (step 2, before this handler's own `buildKongEmailTemplateMounts`
          // ever runs) reads both content_path files from the project-root base.
          yield* fs.makeDirectory(path.join(workdir, "supabase", "templates"), { recursive: true });
          yield* fs.writeFileString(
            path.join(workdir, "supabase", "templates", "confirmation.html"),
            "<html></html>",
          );
          yield* fs.writeFileString(
            path.join(workdir, "supabase", "templates", "custom_notice.html"),
            "<html></html>",
          );

          yield* start(flags()).pipe(Effect.provide(layer));
          const createdNames = createdContainerNames(child.spawned);
          expect(createdNames.some((name) => name.includes("_pooler_"))).toBe(true);
          expect(createdNames.some((name) => name.includes("_auth_"))).toBe(true);
          // The Kong mount must read from the same project-root-relative file config validation
          // already confirmed exists.
          const kongCreate = child.spawned.find(
            (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_kong_"),
          );
          const notificationBind = kongCreate?.args.find(
            (arg, index) =>
              kongCreate.args[index - 1] === "-v" && arg.includes("custom_notice_notification"),
          );
          expect(notificationBind).toContain(
            path.join(workdir, "supabase", "templates/custom_notice.html"),
          );
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      // "0s" performs exactly one immediate health probe with no retries, not a 30s fallback.
      // The mock heals on the first check either way, so this only proves "0s" doesn't hang,
      // not the retry count.
      "accepts a zero db.health_timeout without hanging, and blanks webauthn fields on an empty [auth.webauthn] section",
      () =>
        Effect.gen(function* () {
          const { layer } = yield* setup({
            configContents: 'project_id = "demo"\n[db]\nhealth_timeout = "0s"\n[auth.webauthn]\n',
          });
          return yield* start(flags()).pipe(Effect.provide(layer));
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails config loading on an unparseable db.health_timeout before any Docker work, matching Go's Config.Load",
      () =>
        Effect.gen(function* () {
          const { layer, child } = yield* setup({
            configContents: 'project_id = "demo"\n[db]\nhealth_timeout = "not-a-duration"\n',
          });

          const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = Cause.pretty(exit.cause);
            expect(serialized).toContain("StartInvalidConfigError");
            expect(serialized).toContain("failed to parse config");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid storage.file_size_limit even when storage is excluded, matching Go's Config.Load",
      () =>
        Effect.gen(function* () {
          const { layer, child } = yield* setup({
            configContents: 'project_id = "demo"\n[storage]\nfile_size_limit = "not-a-size"\n',
          });

          const exit = yield* Effect.exit(
            start(flags({ exclude: ["storage"] })).pipe(Effect.provide(layer)),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = Cause.pretty(exit.cause);
            expect(serialized).toContain("StartInvalidConfigError");
            expect(serialized).toContain("invalid config for storage.file_size_limit");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid SUPABASE_STORAGE_S3_PROTOCOL_ENABLED even when storage is excluded, matching Go's Config.Load",
      () =>
        withEnvVar(
          "SUPABASE_STORAGE_S3_PROTOCOL_ENABLED",
          "not-a-bool",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              const exit = yield* Effect.exit(
                start(flags({ exclude: ["storage"] })).pipe(Effect.provide(layer)),
              );
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
                expect(serialized).toContain("invalid config for storage.s3_protocol.enabled");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid SUPABASE_STORAGE_ANALYTICS_ENABLED even when storage is excluded, matching Go's Config.Load",
      () =>
        withEnvVar(
          "SUPABASE_STORAGE_ANALYTICS_ENABLED",
          "not-a-bool",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              const exit = yield* Effect.exit(
                start(flags({ exclude: ["storage"] })).pipe(Effect.provide(layer)),
              );
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
                expect(serialized).toContain("invalid config for storage.analytics.enabled");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid SUPABASE_STORAGE_ANALYTICS_MAX_NAMESPACES even when storage is excluded, matching Go's Config.Load",
      () =>
        withEnvVar(
          "SUPABASE_STORAGE_ANALYTICS_MAX_NAMESPACES",
          "not-a-uint",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              const exit = yield* Effect.exit(
                start(flags({ exclude: ["storage"] })).pipe(Effect.provide(layer)),
              );
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
                expect(serialized).toContain("invalid config for storage.analytics.max_namespaces");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid SUPABASE_STORAGE_ANALYTICS_MAX_TABLES even when storage is excluded, matching Go's Config.Load",
      () =>
        withEnvVar(
          "SUPABASE_STORAGE_ANALYTICS_MAX_TABLES",
          "not-a-uint",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              const exit = yield* Effect.exit(
                start(flags({ exclude: ["storage"] })).pipe(Effect.provide(layer)),
              );
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
                expect(serialized).toContain("invalid config for storage.analytics.max_tables");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid SUPABASE_STORAGE_ANALYTICS_MAX_CATALOGS even when storage is excluded, matching Go's Config.Load",
      () =>
        withEnvVar(
          "SUPABASE_STORAGE_ANALYTICS_MAX_CATALOGS",
          "not-a-uint",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              const exit = yield* Effect.exit(
                start(flags({ exclude: ["storage"] })).pipe(Effect.provide(layer)),
              );
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
                expect(serialized).toContain("invalid config for storage.analytics.max_catalogs");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid SUPABASE_STORAGE_VECTOR_MAX_BUCKETS even when storage is excluded, matching Go's Config.Load",
      () =>
        withEnvVar(
          "SUPABASE_STORAGE_VECTOR_MAX_BUCKETS",
          "not-a-uint",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              const exit = yield* Effect.exit(
                start(flags({ exclude: ["storage"] })).pipe(Effect.provide(layer)),
              );
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
                expect(serialized).toContain("invalid config for storage.vector.max_buckets");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid SUPABASE_STORAGE_VECTOR_MAX_INDEXES even when storage is excluded, matching Go's Config.Load",
      () =>
        withEnvVar(
          "SUPABASE_STORAGE_VECTOR_MAX_INDEXES",
          "not-a-uint",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              const exit = yield* Effect.exit(
                start(flags({ exclude: ["storage"] })).pipe(Effect.provide(layer)),
              );
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
                expect(serialized).toContain("invalid config for storage.vector.max_indexes");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid auth.sms.max_frequency even when auth is disabled, matching Go's Config.Load",
      () =>
        Effect.gen(function* () {
          const { layer, child } = yield* setup({
            configContents:
              'project_id = "demo"\n[auth]\nenabled = false\n[auth.sms]\nmax_frequency = "not-a-duration"\n',
          });

          const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = Cause.pretty(exit.cause);
            expect(serialized).toContain("StartInvalidConfigError");
            expect(serialized).toContain("invalid config for auth.sms.max_frequency");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid SUPABASE_AUTH_RATE_LIMIT_ANONYMOUS_USERS even when auth is disabled, matching Go's Config.Load",
      () =>
        withEnvVar(
          "SUPABASE_AUTH_RATE_LIMIT_ANONYMOUS_USERS",
          "not-a-uint",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({
                configContents: 'project_id = "demo"\n[auth]\nenabled = false\n',
              });

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
                expect(serialized).toContain("invalid config for auth.rate_limit");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid SUPABASE_AUTH_WEB3_SOLANA_ENABLED even when auth is disabled, matching Go's Config.Load",
      () =>
        withEnvVar(
          "SUPABASE_AUTH_WEB3_SOLANA_ENABLED",
          "not-a-bool",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({
                configContents: 'project_id = "demo"\n[auth]\nenabled = false\n',
              });

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
                expect(serialized).toContain("invalid config for auth.web3");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid SUPABASE_AUTH_OAUTH_SERVER_ENABLED even when auth is disabled, matching Go's Config.Load",
      () =>
        withEnvVar(
          "SUPABASE_AUTH_OAUTH_SERVER_ENABLED",
          "not-a-bool",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({
                configContents: 'project_id = "demo"\n[auth]\nenabled = false\n',
              });

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
                expect(serialized).toContain("invalid config for auth.oauth_server");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED even when auth is disabled, matching Go's Config.Load",
      () =>
        withEnvVar(
          "SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED",
          "not-a-bool",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({
                configContents: 'project_id = "demo"\n[auth]\nenabled = false\n',
              });

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
                expect(serialized).toContain("invalid config for auth.third_party");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid auth.passkey.enabled even when auth is disabled, matching Go's Config.Load",
      () =>
        Effect.gen(function* () {
          const { layer, child } = yield* setup({
            configContents:
              'project_id = "demo"\n[auth]\nenabled = false\n[auth.passkey]\nenabled = "bad"\n',
          });

          const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = Cause.pretty(exit.cause);
            expect(serialized).toContain("StartInvalidConfigError");
            expect(serialized).toContain("invalid config for auth.passkey");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid auth.external.<custom>.enabled even when auth is disabled, matching Go's Config.Load",
      () =>
        Effect.gen(function* () {
          const { layer, child } = yield* setup({
            configContents:
              'project_id = "demo"\n[auth]\nenabled = false\n[auth.external.custom]\nenabled = "bad"\n',
          });

          const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = Cause.pretty(exit.cause);
            expect(serialized).toContain("StartInvalidConfigError");
            expect(serialized).toContain("invalid config for auth.external");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on a per-function env field, matching Go's Config.Load rejecting an unknown functions[slug] key",
      () =>
        Effect.gen(function* () {
          const { layer, child } = yield* setup({
            configContents:
              'project_id = "demo"\n[functions.foo]\nenabled = true\n[functions.foo.env]\nFOO = "env(SOME_VAR)"\n',
          });

          const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = Cause.pretty(exit.cause);
            expect(serialized).toContain("StartInvalidConfigError");
            expect(serialized).toContain("'functions[foo]' has invalid keys: env");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid SUPABASE_EDGE_RUNTIME_POLICY even when edge-runtime is excluded, matching Go's Config.Load",
      () =>
        withEnvVar(
          "SUPABASE_EDGE_RUNTIME_POLICY",
          "not-a-policy",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              const exit = yield* Effect.exit(
                start(flags({ exclude: ["edge-runtime"] })).pipe(Effect.provide(layer)),
              );
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
                expect(serialized).toContain("invalid config for edge_runtime.policy");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an invalid SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT even when edge-runtime is excluded, matching Go's Config.Load",
      () =>
        withEnvVar(
          "SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT",
          "not-a-port",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              const exit = yield* Effect.exit(
                start(flags({ exclude: ["edge-runtime"] })).pipe(Effect.provide(layer)),
              );
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
                expect(serialized).toContain("invalid config for edge_runtime.inspector_port");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "warns about a Windows npipe Docker daemon before starting Vector, in text mode, and excludes it from the health watch list",
      () =>
        withEnvVar(
          "DOCKER_HOST",
          "npipe:////./pipe/docker_engine",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, out } = yield* setup();

              yield* start(flags()).pipe(Effect.provide(layer));
              expect(out.stderrText).toContain(
                "Analytics on Windows requires Docker daemon exposed on tcp://localhost:2375.",
              );
              expect(out.stderrText).toContain("Started");
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("service gating", () => {
    it.live(
      "skips analytics services (logflare + vector) together when analytics.enabled = false",
      () =>
        Effect.gen(function* () {
          const { layer, child } = yield* setup({
            configContents: 'project_id = "demo"\n[analytics]\nenabled = false\n',
          });

          yield* start(flags()).pipe(Effect.provide(layer));
          const createdNames = createdContainerNames(child.spawned);
          expect(createdNames.some((name) => name.includes("_analytics_"))).toBe(false);
          expect(createdNames.some((name) => name.includes("_vector_"))).toBe(false);
          expect(createdNames.some((name) => name.includes("_kong_"))).toBe(true);
          expect(createdNames.some((name) => name.includes("_auth_"))).toBe(true);
          expect(createdNames.some((name) => name.includes("_storage_"))).toBe(true);
          expect(createdNames.some((name) => name.includes("_studio_"))).toBe(true);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "skips storage and imgproxy together when storage.enabled = false, even with image_transformation on",
      () =>
        Effect.gen(function* () {
          const { layer, child } = yield* setup({
            configContents:
              'project_id = "demo"\n[storage]\nenabled = false\n[storage.image_transformation]\nenabled = true\n',
          });

          yield* start(flags()).pipe(Effect.provide(layer));
          const createdNames = createdContainerNames(child.spawned);
          expect(createdNames.some((name) => name.includes("_storage_"))).toBe(false);
          expect(createdNames.some((name) => name.includes("_imgproxy_"))).toBe(false);
          expect(createdNames.some((name) => name.includes("_kong_"))).toBe(true);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "ignores SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED when [storage.image_transformation] is absent from config.toml",
      () =>
        withEnvVar(
          "SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED",
          "true",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              yield* start(flags()).pipe(Effect.provide(layer));
              const createdNames = createdContainerNames(child.spawned);
              expect(createdNames.some((name) => name.includes("_storage_"))).toBe(true);
              expect(createdNames.some((name) => name.includes("_imgproxy_"))).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "starts Kong and Realtime even when api.enabled is false, since only Postgrest depends on it",
      () =>
        Effect.gen(function* () {
          const { layer, child } = yield* setup({
            configContents: 'project_id = "demo"\n[api]\nenabled = false\n',
            httpClientLayer: unusedHttpClientLayer,
          });

          // `edge-runtime` excluded so its own HTTP readiness probe never reaches
          // `unusedHttpClientLayer` — this scenario is only about Postgrest/Kong/Realtime's
          // `api.enabled` independence.
          yield* start(flags({ exclude: ["edge-runtime"] })).pipe(Effect.provide(layer));
          const createdNames = createdContainerNames(child.spawned);
          expect(createdNames.some((name) => name.includes("_kong_"))).toBe(true);
          expect(createdNames.some((name) => name.includes("_realtime_"))).toBe(true);
          expect(createdNames.some((name) => name.includes("_rest_"))).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "excluding a single --exclude key skips exactly that container and starts every other excludable service",
      () =>
        Effect.gen(function* () {
          expect(new Set(START_EXCLUDABLE_KEYS)).toEqual(
            new Set(Object.keys(CONTAINER_SUFFIX_BY_EXCLUDE_KEY)),
          );
          return yield* Effect.gen(function* () {
            for (const excludeKey of START_EXCLUDABLE_KEYS) {
              const { layer, child } = yield* setup({
                configContents:
                  'project_id = "demo"\n[storage.image_transformation]\nenabled = true\n[db.pooler]\nenabled = true\n',
              });
              yield* start(flags({ exclude: [excludeKey] })).pipe(Effect.provide(layer));

              const createdNames = createdContainerNames(child.spawned);
              expect(
                createdNames.filter((name) => name.includes("_db_")),
                excludeKey,
              ).toHaveLength(1);
              const missing = missingSuffixesForExcludeKey(excludeKey);
              for (const suffix of ALL_EXCLUDABLE_SUFFIXES) {
                const shouldExist = !missing.includes(suffix);
                const actuallyExists = createdNames.some((name) => name.includes(`_${suffix}_`));
                expect(actuallyExists, `excludeKey=${excludeKey} suffix=${suffix}`).toBe(
                  shouldExist,
                );
              }
            }
          });
        }).pipe(Effect.provide(BunServices.layer)),
      15_000,
    );
  });

  describe("fresh volume: DB setup + bucket seeding", () => {
    /** The three PG15+ one-shot migrate jobs (`startSetupLocalDatabase`'s `DockerRun` calls) — a plain `docker run --rm ...`, distinct from Edge Runtime's own create/cp/start bring-up. */
    function dbSetupJobCalls(spawned: ReadonlyArray<SpawnRecord>): ReadonlyArray<SpawnRecord> {
      return spawned.filter((s) => s.args[0] === "run" && s.args[1] === "--rm");
    }

    it.live(
      "triggers the SetupLocalDatabase-equivalent pipeline (PG15+ one-shot migrate jobs) on a fresh volume",
      () =>
        Effect.gen(function* () {
          const { layer, out, child } = yield* setup({ route: freshVolumeRoute(defaultRoute()) });

          // Excludes edge-runtime to keep this scenario focused on the fresh-volume
          // DB-setup path only.
          yield* start(flags({ exclude: ["edge-runtime"] })).pipe(Effect.provide(layer));
          expect(out.stderrText).toContain("Initialising schema...");
          // Default config: realtime, storage, and auth are all enabled.
          expect(dbSetupJobCalls(child.spawned)).toHaveLength(3);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "resolves an excluded service's migrate-job image through a project-dotenv-only registry override",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workdir = tempRoot.current;
          const { layer, child } = yield* setup({ route: freshVolumeRoute(defaultRoute()) });
          // Written after `setup()` so the `supabase/` dir (created by `writeConfig`) already exists.
          yield* fs.writeFileString(
            path.join(workdir, "supabase", ".env"),
            "SUPABASE_INTERNAL_IMAGE_REGISTRY=registry.example.com\n",
          );

          yield* start(flags({ exclude: ["gotrue"] })).pipe(Effect.provide(layer));
          expect(dbSetupJobCalls(child.spawned)).toHaveLength(3);
          const authMigrateJob = dbSetupJobCalls(child.spawned).find((s) =>
            s.args.some((arg) => arg.includes("gotrue")),
          );
          expect(
            authMigrateJob?.args.some((arg) => arg.startsWith("registry.example.com/supabase/")),
          ).toBe(true);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "does not attempt to resolve an excluded service's migrate-job image on a non-fresh-volume restart",
      () =>
        Effect.gen(function* () {
          const base = defaultRoute();
          const route = (args: ReadonlyArray<string>): RouteResult => {
            const targetsStorageImage =
              (args[0] === "image" && args[1] === "inspect" && args[2]?.includes("storage-api")) ===
                true ||
              (args[0] === "pull" && args[1]?.includes("storage-api") === true);
            if (targetsStorageImage) {
              return { exitCode: 1, stderr: ["Error: toomanyrequests: rate limit exceeded"] };
            }
            return base(args);
          };
          const { layer, child } = yield* setup({ route });

          yield* start(flags({ exclude: ["storage-api"] })).pipe(Effect.provide(layer));
          const createdNames = createdContainerNames(child.spawned);
          expect(createdNames.some((name) => name.includes("_storage_"))).toBe(false);
          expect(createdNames.some((name) => name.includes("_kong_"))).toBe(true);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("skips the SetupLocalDatabase-equivalent pipeline on a non-fresh volume", () =>
      Effect.gen(function* () {
        const { layer, out, child } = yield* setup();

        yield* start(flags({ exclude: ["edge-runtime"] })).pipe(Effect.provide(layer));
        expect(out.stderrText).not.toContain("Initialising schema...");
        expect(dbSetupJobCalls(child.spawned)).toHaveLength(0);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on an undecryptable [db.vault] secret even on a non-fresh volume, matching Go's Config.Load",
      () =>
        withEnvVar(
          "DOTENV_PRIVATE_KEY",
          undefined,
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const encrypted =
                "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";
              const { layer, child } = yield* setup({
                configContents: `project_id = "demo"\n[db.vault]\nmy_secret = "${encrypted}"\n`,
              });

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("failed to parse config: missing private key");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on a bucket's invalid file_size_limit even on a non-fresh volume, matching Go's Config.Load",
      () =>
        Effect.gen(function* () {
          const { layer, child } = yield* setup({
            configContents:
              'project_id = "demo"\n[storage.buckets.avatars]\nfile_size_limit = "bogus"\n',
          });

          const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = Cause.pretty(exit.cause);
            expect(serialized).toContain("DbConfigLoadError");
            expect(serialized).toContain(
              "failed to parse config: invalid storage.buckets.avatars.file_size_limit.",
            );
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live('prints "Starting database..." on a fresh volume, before Postgres is created', () =>
      Effect.gen(function* () {
        const { layer, out } = yield* setup({ route: freshVolumeRoute(defaultRoute()) });

        yield* start(flags({ exclude: ["edge-runtime"] })).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Starting database...\n");
        expect(out.stderrText).not.toContain("Starting database from backup...");
        expect(out.stderrText.indexOf("Starting database...\n")).toBeLessThan(
          out.stderrText.indexOf("Initialising schema..."),
        );
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      'prints "Starting database from backup..." on a restart (an already-existing volume)',
      () =>
        Effect.gen(function* () {
          const { layer, out } = yield* setup();

          yield* start(flags({ exclude: ["edge-runtime"] })).pipe(Effect.provide(layer));
          expect(out.stderrText).toContain("Starting database from backup...\n");
          expect(out.stderrText).not.toContain("Starting database...\n");
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "still writes supabase/.branches/_current_branch on a restart, even though the fresh-volume DB setup is skipped",
      () =>
        Effect.gen(function* () {
          const { layer, workdir } = yield* setup();

          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* start(flags({ exclude: ["edge-runtime"] })).pipe(Effect.provide(layer));
          const content = yield* fs.readFileString(
            path.join(workdir, "supabase", ".branches", "_current_branch"),
          );
          expect(content).toBe("main");
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("seeds a configured bucket on a fresh volume with storage enabled", () =>
      Effect.gen(function* () {
        const http = mockStorageBucketHttpClient();
        const { layer } = yield* setup({
          configContents: 'project_id = "demo"\n[storage.buckets.avatars]\npublic = false\n',
          route: freshVolumeRoute(defaultRoute()),
          httpClientLayer: http.layer,
        });

        yield* start(flags({ exclude: ["edge-runtime"] })).pipe(Effect.provide(layer));
        expect(http.createdBucketRequests).toHaveLength(1);
        // docker.io Storage carries its own Docker healthcheck, so readiness
        // never goes through the gateway.
        expect(http.requests.some((entry) => entry.url.includes("/storage/v1/status"))).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("keeps a vector bucket missing from config.toml (prune declines without consent)", () =>
      Effect.gen(function* () {
        const http = mockStorageVectorHttpClient(["embeddings", "stale-vec"]);
        const { layer } = yield* setup({
          configContents:
            'project_id = "demo"\n[storage.vector]\nenabled = true\n[storage.vector.buckets.embeddings]\n',
          route: freshVolumeRoute(defaultRoute()),
          httpClientLayer: http.layer,
        });
        // A truthy ambient `SUPABASE_YES` would auto-confirm the prune.
        return yield* withEnvVar(
          "SUPABASE_YES",
          undefined,
          Effect.gen(function* () {
            yield* start(flags({ exclude: ["edge-runtime"] }));
            expect(http.vectorListCalls).toBe(1);
            expect(http.deletedVectorBuckets).toHaveLength(0);
          }).pipe(Effect.provide(layer)),
        );
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "never asks before overwriting an existing bucket, so piped stdin stays untouched",
      () =>
        Effect.gen(function* () {
          const http = mockStorageBucketHttpClient(["avatars"]);
          const { layer, out } = yield* setup({
            configContents: 'project_id = "demo"\n[storage.buckets.avatars]\npublic = false\n',
            route: freshVolumeRoute(defaultRoute()),
            httpClientLayer: http.layer,
            stdinInput: "n\necho SCRIPT-LINE-2\n",
          });
          return yield* withEnvVar(
            "SUPABASE_YES",
            undefined,
            Effect.gen(function* () {
              yield* start(flags({ exclude: ["edge-runtime"] }));
              expect(out.stderrText).not.toContain("Do you want to overwrite its properties?");
            }).pipe(Effect.provide(layer)),
          );
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "never reads piped stdin for the seeding confirmations, so a piped y cannot consent",
      () =>
        Effect.gen(function* () {
          const http = mockStorageVectorHttpClient(["embeddings", "stale-vec"]);
          const { layer, out } = yield* setup({
            configContents:
              'project_id = "demo"\n[storage.vector]\nenabled = true\n[storage.vector.buckets.embeddings]\n',
            route: freshVolumeRoute(defaultRoute()),
            httpClientLayer: http.layer,
            // A line a parent script would own. The old prompt read fd 0 here and would have
            // taken this as consent; `start` must leave it untouched.
            stdinInput: "y\necho SCRIPT-LINE-2\n",
          });
          return yield* withEnvVar(
            "SUPABASE_YES",
            undefined,
            Effect.gen(function* () {
              yield* start(flags({ exclude: ["edge-runtime"] }));
              expect(http.deletedVectorBuckets).toHaveLength(0);
              expect(out.stderrText).not.toContain("Do you want to prune it?");
              expect(out.stderrText).toContain("Keeping vector bucket");
            }).pipe(Effect.provide(layer)),
          );
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("prunes a stale vector bucket on a fresh-volume start when SUPABASE_YES consents", () =>
      Effect.gen(function* () {
        const http = mockStorageVectorHttpClient(["embeddings", "stale-vec"]);
        const { layer } = yield* setup({
          configContents:
            'project_id = "demo"\n[storage.vector]\nenabled = true\n[storage.vector.buckets.embeddings]\n',
          route: freshVolumeRoute(defaultRoute()),
          httpClientLayer: http.layer,
        });
        return yield* withEnvVar(
          "SUPABASE_YES",
          "1",
          Effect.gen(function* () {
            yield* start(flags({ exclude: ["edge-runtime"] }));
            expect(http.deletedVectorBuckets).toHaveLength(1);
            expect(http.deletedVectorBuckets[0]).toContain("stale-vec");
          }).pipe(Effect.provide(layer)),
        );
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "does not seed a configured bucket on a non-fresh volume, even with storage enabled",
      () =>
        Effect.gen(function* () {
          const http = mockStorageBucketHttpClient();
          const { layer } = yield* setup({
            configContents: 'project_id = "demo"\n[storage.buckets.avatars]\npublic = false\n',
            httpClientLayer: http.layer,
          });

          yield* start(flags({ exclude: ["edge-runtime"] })).pipe(Effect.provide(layer));
          expect(http.createdBucketRequests).toHaveLength(0);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("seeds against the env-overridden SUPABASE_API_PORT, not config.toml's raw port", () =>
      withEnvVar(
        "SUPABASE_API_PORT",
        "65432",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const http = mockStorageBucketHttpClient();
            const { layer } = yield* setup({
              configContents: 'project_id = "demo"\n[storage.buckets.avatars]\npublic = false\n',
              route: freshVolumeRoute(defaultRoute()),
              httpClientLayer: http.layer,
            });

            yield* start(flags({ exclude: ["edge-runtime"] })).pipe(Effect.provide(layer));
            expect(http.createdBucketRequests).toHaveLength(1);
            expect(http.createdBucketRequests[0]).toContain(":65432/");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "seeds against the env-overridden SUPABASE_API_EXTERNAL_URL, not config.toml's raw value",
      () =>
        withEnvVar(
          "SUPABASE_API_EXTERNAL_URL",
          "http://override.example.com:9999",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const http = mockStorageBucketHttpClient();
              const { layer } = yield* setup({
                configContents: 'project_id = "demo"\n[storage.buckets.avatars]\npublic = false\n',
                route: freshVolumeRoute(defaultRoute()),
                httpClientLayer: http.layer,
              });

              yield* start(flags({ exclude: ["edge-runtime"] })).pipe(Effect.provide(layer));
              expect(http.createdBucketRequests).toHaveLength(1);
              expect(http.createdBucketRequests[0]).toContain("override.example.com:9999");
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "seeds a bucket's default file_size_limit from the env-overridden SUPABASE_STORAGE_FILE_SIZE_LIMIT",
      () =>
        withEnvVar(
          "SUPABASE_STORAGE_FILE_SIZE_LIMIT",
          "10MiB",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const http = mockStorageBucketHttpClient();
              const { layer } = yield* setup({
                configContents: 'project_id = "demo"\n[storage.buckets.avatars]\npublic = false\n',
                route: freshVolumeRoute(defaultRoute()),
                httpClientLayer: http.layer,
              });

              yield* start(flags({ exclude: ["edge-runtime"] })).pipe(Effect.provide(layer));
              expect(http.createdBucketBodies).toHaveLength(1);
              expect(
                (http.createdBucketBodies[0] as { file_size_limit?: number })?.file_size_limit,
              ).toBe(10 * 1024 * 1024);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("edge runtime", () => {
    /** Edge Runtime's own bring-up (`startStackEdgeRuntimeContainer`) is a `docker create` → `docker cp` (main-service archive) → `docker start` sequence; its create is the one naming the `_edge_runtime_` container, distinguishing it from every other service's `createContainer` create. */
    function edgeRuntimeRunCalls(spawned: ReadonlyArray<SpawnRecord>): ReadonlyArray<SpawnRecord> {
      return spawned.filter((s) => isEdgeRuntimeCreate(s.args));
    }

    it.live("creates and starts a real container when enabled and not excluded", () =>
      Effect.gen(function* () {
        const { layer, child } = yield* setup();

        yield* start(flags()).pipe(Effect.provide(layer));
        const runCalls = edgeRuntimeRunCalls(child.spawned);
        expect(runCalls).toHaveLength(1);
        const nameIndex = runCalls[0]?.args.indexOf("--name") ?? -1;
        const containerName = runCalls[0]?.args[nameIndex + 1] ?? "";
        expect(containerName).toContain("_edge_runtime_");
        // The main service is `docker cp`-streamed in, never a single-file host bind (#6254).
        const bindValues = (runCalls[0]?.args ?? []).flatMap((arg, index) =>
          runCalls[0]?.args[index - 1] === "-v" ? [arg] : [],
        );
        expect(bindValues.some((bind) => bind.includes(":/root/index.ts"))).toBe(false);
        expect(child.spawned.map((s) => s.args.slice(0, 3))).toContainEqual([
          "cp",
          "-",
          `${containerName}:/`,
        ]);
        expect(child.spawned.map((s) => s.args)).toContainEqual(["start", containerName]);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("--exclude edge-runtime skips its container entirely", () =>
      Effect.gen(function* () {
        const { layer, child } = yield* setup();

        yield* start(flags({ exclude: ["edge-runtime"] })).pipe(Effect.provide(layer));
        expect(edgeRuntimeRunCalls(child.spawned)).toHaveLength(0);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "keeps the host-side staged env artifacts after a successful bring-up (no eager cleanup)",
      () =>
        Effect.gen(function* () {
          const { layer, child, workdir } = yield* setup();

          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          yield* start(flags()).pipe(Effect.provide(layer));
          const runArgs = edgeRuntimeRunCalls(child.spawned)[0]?.args ?? [];
          const envFileIndex = runArgs.indexOf("--env-file");
          const envFilePath = envFileIndex === -1 ? undefined : runArgs[envFileIndex + 1];
          expect(envFilePath).toBeDefined();
          const stagingRoot = path.join(workdir, "supabase", ".temp", "start-secrets");
          expect(envFilePath?.startsWith(stagingRoot)).toBe(true);
          try {
            expect(yield* fs.exists(envFilePath ?? "")).toBe(true);
            // `<stagingRoot>/<container>/env/docker.env` → the staging dir is two levels up.
            const containerStagingDir = path.join(envFilePath ?? "", "..", "..");
            expect(yield* fs.exists(path.join(containerStagingDir, "main"))).toBe(false);
          } finally {
            yield* fs.remove(stagingRoot, { recursive: true, force: true });
          }
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "logs 'Skipped serving Function' for a disabled function via Studio's bind mounts, even with Edge Runtime excluded",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workdir = tempRoot.current;
          yield* fs.makeDirectory(path.join(workdir, "supabase", "functions", "foo"), {
            recursive: true,
          });
          yield* fs.writeFileString(
            path.join(workdir, "supabase", "functions", "foo", "index.ts"),
            "export {};\n",
          );
          const { layer, out } = yield* setup({
            configContents: 'project_id = "demo"\n[functions.foo]\nenabled = false\n',
          });
          return yield* Effect.gen(function* () {
            yield* start(flags({ exclude: ["edge-runtime"] }));
            expect(out.stderrText).toContain("Skipped serving Function: foo");
          }).pipe(
            Effect.provide(layer),
            Effect.ensuring(
              Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                const path = yield* Path.Path;
                yield* fs.remove(path.join(workdir, "supabase", "functions"), {
                  recursive: true,
                  force: true,
                });
              }).pipe(Effect.orDie),
            ),
          );
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "does not pick up an unrelated ancestor project's functions for a config-less --workdir subdirectory",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const ancestorRoot = tempRoot.current;
          yield* fs.makeDirectory(path.join(ancestorRoot, "supabase", "functions", "foo"), {
            recursive: true,
          });
          yield* fs.writeFileString(
            path.join(ancestorRoot, "supabase", "functions", "foo", "index.ts"),
            "export {};\n",
          );
          yield* fs.writeFileString(
            path.join(ancestorRoot, "supabase", "config.toml"),
            'project_id = "ancestor"\n[functions.foo]\nenabled = true\n',
          );
          const workdir = path.join(ancestorRoot, "nested", "workdir");
          yield* fs.makeDirectory(workdir, { recursive: true });
          const { layer, out, child } = yield* setup({ workdir, skipConfig: true });
          return yield* Effect.gen(function* () {
            const path = yield* Path.Path;
            yield* start(flags());
            const runArgs = edgeRuntimeRunCalls(child.spawned)[0]?.args ?? [];
            const bindValues = runArgs.flatMap((arg, i) => (runArgs[i - 1] === "-v" ? [arg] : []));
            expect(bindValues.some((bind) => bind.includes(path.join("functions", "foo")))).toBe(
              false,
            );
            expect(out.stderrText).not.toContain("foo");
          }).pipe(
            Effect.provide(layer),
            Effect.ensuring(
              Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                const path = yield* Path.Path;
                yield* fs.remove(path.join(ancestorRoot, "supabase", "functions"), {
                  recursive: true,
                  force: true,
                });
              }).pipe(Effect.orDie),
            ),
          );
        }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("image pull", () => {
    it.live(
      "retries a rate-limited image pull and succeeds",
      () =>
        Effect.gen(function* () {
          const pullAttempts = new Map<string, number>();
          const base = defaultRoute();
          const route = (args: ReadonlyArray<string>): RouteResult => {
            // A confirmed "no such image" (not merely a non-zero exit) is what tells
            // `hasLocalImage` this is a genuine cache miss, forcing every image through the pull path.
            if (args[0] === "image" && args[1] === "inspect") {
              return {
                exitCode: 1,
                stderr: [`Error response from daemon: No such image: ${args[2]}`],
              };
            }
            if (args[0] === "pull") {
              const image = args[1] ?? "";
              if (image.includes("kong")) {
                const attempt = (pullAttempts.get(image) ?? 0) + 1;
                pullAttempts.set(image, attempt);
                if (attempt === 1) {
                  return {
                    exitCode: 1,
                    stderr: ["toomanyrequests: You have reached your pull rate limit"],
                  };
                }
              }
              return { exitCode: 0 };
            }
            return base(args);
          };
          const { layer, out, child } = yield* setup({ route });

          yield* start(flags()).pipe(Effect.provide(layer));
          const kongPulls = child.spawned.filter(
            (s) => s.args[0] === "pull" && (s.args[1] ?? "").includes("kong"),
          );
          expect(kongPulls.length).toBeGreaterThanOrEqual(2);
          expect(out.stderrText).toContain("Started");
        }).pipe(Effect.provide(BunServices.layer)),
      10_000,
    );

    it.live(
      "fails with a pull error once all registry candidates are exhausted, without a rollback (nothing was created yet)",
      () =>
        Effect.gen(function* () {
          const base = defaultRoute();
          const route = (args: ReadonlyArray<string>): RouteResult => {
            if (args[0] === "image" && args[1] === "inspect") {
              return {
                exitCode: 1,
                stderr: [`Error response from daemon: No such image: ${args[2]}`],
              };
            }
            if (args[0] === "pull") {
              const image = args[1] ?? "";
              if (image.includes("kong")) {
                return { exitCode: 1, stderr: ["toomanyrequests: rate limit exceeded"] };
              }
              return { exitCode: 0 };
            }
            return base(args);
          };
          const { layer, child } = yield* setup({ route });

          const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("ImagePrepullError");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
          expect(rollbackWasAttempted(child.spawned)).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
      45_000,
    );

    it.live(
      "still fails when the daemon dies mid-pre-pull under --ignore-health-check — Go's exit-0 swallow is an unintended quirk this port deliberately does not reproduce (CLI-1987)",
      () =>
        Effect.gen(function* () {
          const base = defaultRoute();
          const route = (args: ReadonlyArray<string>): RouteResult => {
            if (args[0] === "image" && args[1] === "inspect") {
              const image = args[2] ?? "";
              if (image.includes("kong")) {
                return {
                  exitCode: 1,
                  stderr: [
                    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
                  ],
                };
              }
              return { exitCode: 1 };
            }
            if (args[0] === "pull") return { exitCode: 0 };
            return base(args);
          };
          const { layer, out, child } = yield* setup({ route });

          const exit = yield* Effect.exit(
            start(flags({ ignoreHealthCheck: true })).pipe(Effect.provide(layer)),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("ImagePrepullError");
          }
          expect(out.stderrText).not.toContain("Started");
          expect(out.stderrText).not.toContain("Local dev security notice");
          expect(out.stdoutText).toBe("");
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
          expect(rollbackWasAttempted(child.spawned)).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
      45_000,
    );
  });

  describe("rollback on bring-up failure", () => {
    it.live(
      "rolls back on a SIGINT-style interruption mid-bring-up, matching Go's context.Canceled rollback",
      () =>
        Effect.gen(function* () {
          const neverHealthy = new Set<string>();
          const route = defaultRoute({ neverHealthy });
          let dbContainerId: string | undefined;
          const { layer, child } = yield* setup({
            route: (args) => {
              if (args[0] === "create") {
                const name = containerNameFromCreateArgs(args);
                if (name.includes("_db_")) {
                  neverHealthy.add(name);
                  dbContainerId = name;
                }
              }
              return route(args);
            },
          });
          return yield* Effect.gen(function* () {
            const fiber = yield* start(flags()).pipe(
              Effect.provide(layer),
              Effect.forkChild({ startImmediately: true }),
            );
            // Wait until the health check has actually probed the never-healthy `db` container,
            // proving the fiber is suspended inside the retry loop, not merely past `create`.
            while (
              dbContainerId === undefined ||
              !child.spawned.some(
                (s) =>
                  s.args[0] === "container" &&
                  s.args[1] === "inspect" &&
                  s.args[2] === dbContainerId,
              )
            ) {
              yield* Effect.sleep("5 millis");
            }
            // `Fiber.interrupt` only resolves once the target fiber (and its finalizers,
            // including the `Effect.onError` rollback) has fully completed.
            yield* Fiber.interrupt(fiber);
            expect(rollbackWasAttempted(child.spawned)).toBe(true);
          });
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "rolls back on a SIGINT-style interruption during the post-bring-up bulk health-check wait",
      () =>
        Effect.gen(function* () {
          const neverHealthy = new Set<string>();
          const route = defaultRoute({ neverHealthy });
          let authContainerId: string | undefined;
          const { layer, child } = yield* setup({
            route: (args) => {
              if (args[0] === "create") {
                const name = containerNameFromCreateArgs(args);
                if (name.includes("_auth_")) {
                  neverHealthy.add(name);
                  authContainerId = name;
                }
              }
              return route(args);
            },
            // Sidesteps the PostgREST/Edge Runtime HTTP-HEAD readiness probes, so this only
            // exercises the Docker-inspect health path.
            httpClientLayer: unusedHttpClientLayer,
          });
          return yield* Effect.gen(function* () {
            const fiber = yield* start(flags({ exclude: ["postgrest", "edge-runtime"] })).pipe(
              Effect.provide(layer),
              Effect.forkChild({ startImmediately: true }),
            );
            // Wait until the bulk health check has probed the never-healthy `auth` container,
            // proving the fiber is suspended inside the retry loop, not merely past the "Waiting
            // for health checks..." message.
            while (
              authContainerId === undefined ||
              !child.spawned.some(
                (s) =>
                  s.args[0] === "container" &&
                  s.args[1] === "inspect" &&
                  s.args[2] === authContainerId,
              )
            ) {
              yield* Effect.sleep("5 millis");
            }
            // `Fiber.interrupt` only resolves once the target fiber (and its finalizers,
            // including the `Effect.onError` rollback) has fully completed.
            yield* Fiber.interrupt(fiber);
            expect(rollbackWasAttempted(child.spawned)).toBe(true);
          });
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("fails and rolls back on a network create failure", () =>
      Effect.gen(function* () {
        const base = defaultRoute();
        const route = (args: ReadonlyArray<string>): RouteResult => {
          if (args[0] === "network" && args[1] === "create") {
            return {
              exitCode: 1,
              stderr: ["Error response from daemon: some other network failure"],
            };
          }
          return base(args);
        };
        const { layer, child } = yield* setup({ route });

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = Cause.pretty(exit.cause);
          expect(serialized).toContain("NetworkCreateError");
          expect(serialized).toContain("failed to create docker network");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        expect(rollbackWasAttempted(child.spawned)).toBe(true);
        expect(child.spawned.some((s) => s.args[0] === "network" && s.args[1] === "prune")).toBe(
          true,
        );
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("fails and rolls back on a container create failure", () =>
      Effect.gen(function* () {
        const base = defaultRoute();
        const route = (args: ReadonlyArray<string>): RouteResult => {
          if (args[0] === "create") {
            return { exitCode: 1, stderr: ["Error: no space left on device"] };
          }
          return base(args);
        };
        const { layer, child } = yield* setup({ route });

        const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = Cause.pretty(exit.cause);
          expect(serialized).toContain("ContainerCreateError");
          expect(serialized).toContain("failed to create docker container");
        }
        expect(rollbackWasAttempted(child.spawned)).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails and rolls back on a container start failure, surfacing the port-conflict suggestion",
      () =>
        Effect.gen(function* () {
          const base = defaultRoute();
          const route = (args: ReadonlyArray<string>): RouteResult => {
            if (args[0] === "start") {
              return {
                exitCode: 1,
                stderr: ["Bind for 0.0.0.0:54322 failed: port is already allocated"],
              };
            }
            return base(args);
          };
          const { layer, child } = yield* setup({ route });

          const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = Cause.pretty(exit.cause);
            expect(serialized).toContain("ContainerStartError");
            expect(serialized).toContain("port is already allocated");
            expect(serialized).toContain(
              "Try stopping the project or container already using 0.0.0.0:54322",
            );
          }
          expect(rollbackWasAttempted(child.spawned)).toBe(true);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails on a malformed auth.email.max_frequency before any Docker work, matching Go's Config.Load",
      () =>
        Effect.gen(function* () {
          const { layer, child } = yield* setup({
            configContents: 'project_id = "demo"\n[auth.email]\nmax_frequency = "not-a-duration"\n',
          });

          const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = Cause.pretty(exit.cause);
            expect(serialized).toContain("StartInvalidConfigError");
            expect(serialized).toContain("invalid config for auth.email.max_frequency");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails with a typed config error on a malformed auth.email override even when auth itself is disabled",
      () =>
        withEnvVar(
          "SUPABASE_AUTH_EMAIL_OTP_LENGTH",
          "abc",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({
                configContents: 'project_id = "demo"\n[auth]\nenabled = false\n',
              });

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
              }
              expect(child.spawned).toHaveLength(0);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails with a typed config error on a malformed auth.sms override even when auth itself is disabled",
      () =>
        withEnvVar(
          "SUPABASE_AUTH_SMS_ENABLE_SIGNUP",
          "bad",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({
                configContents: 'project_id = "demo"\n[auth]\nenabled = false\n',
              });

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
              }
              expect(child.spawned).toHaveLength(0);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails and rolls back when Postgres itself never becomes healthy within its configured health_timeout",
      () =>
        Effect.gen(function* () {
          const neverHealthy = new Set<string>();
          const base = defaultRoute({ neverHealthy });
          const route = (args: ReadonlyArray<string>): RouteResult => {
            if (args[0] === "create") {
              const name = containerNameFromCreateArgs(args);
              if (name.includes("_db_")) neverHealthy.add(name);
            }
            return base(args);
          };
          const { layer, child } = yield* setup({
            configContents: 'project_id = "demo"\n[db]\nhealth_timeout = "2s"\n',
            route,
          });

          const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("HealthCheckTimeoutError");
          }
          expect(rollbackWasAttempted(child.spawned)).toBe(true);
          // Postgres's own health wait fails before any other service is ever created.
          expect(createdContainerNames(child.spawned)).toEqual([expect.stringContaining("_db_")]);
        }).pipe(Effect.provide(BunServices.layer)),
      10_000,
    );

    it.live(
      "exits 0 on --ignore-health-check when Postgres itself never becomes healthy, without rolling back and without starting any other service",
      () =>
        Effect.gen(function* () {
          const neverHealthy = new Set<string>();
          const base = defaultRoute({ neverHealthy });
          const route = (args: ReadonlyArray<string>): RouteResult => {
            if (args[0] === "create") {
              const name = containerNameFromCreateArgs(args);
              if (name.includes("_db_")) neverHealthy.add(name);
            }
            // Postgres's own health wait builds its `images` map separately from the bulk one,
            // so this scripts the marker here too.
            if (args[0] === "logs" && (args[1] ?? "").includes("_db_")) {
              return { stdout: ["exec /usr/local/bin/docker-entrypoint.sh: exec format error\n"] };
            }
            return base(args);
          };
          const { layer, out, child, analytics } = yield* setup({
            configContents: 'project_id = "demo"\n[db]\nhealth_timeout = "2s"\n',
            route,
          });

          yield* start(flags({ ignoreHealthCheck: true })).pipe(Effect.provide(layer));
          expect(out.stderrText).toContain("is not ready");
          expect(out.stderrText).toContain("Started");
          expect(rollbackWasAttempted(child.spawned)).toBe(false);
          expect(out.stderrText).toContain("supabase_db_demo container is not ready");
          expect(out.stderrText).toContain("supabase_db_demo's image");
          expect(out.stderrText).toContain("image rm -f public.ecr.aws/supabase/postgres:");
          // `--ignore-health-check` leaves the stack up, so a bare restart would be a
          // no-op — the sequence must stop first.
          expect(out.stderrText).toContain("supabase stop");
          // The database bring-up returns before any other service's bring-up begins.
          expect(createdContainerNames(child.spawned)).toEqual([expect.stringContaining("_db_")]);
          // `cli_stack_started`'s capture sits after the entire bring-up + bulk health check,
          // neither of which is reached once Postgres's wait is downgraded to a warning.
          expect(analytics.captured.some((c) => c.event === "cli_stack_started")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
      10_000,
    );

    // Real time, not `it.effect`/`TestClock`: `start` performs genuine async I/O that never
    // resolves under a virtualized clock. `waitForHealthyServices` has no config-configurable
    // timeout seam here (it falls back to the hardcoded 30s default), hence the generous
    // real-time budget.
    it.live(
      "fails and rolls back when a non-Postgres service never becomes healthy within the timeout (no --ignore-health-check)",
      () =>
        Effect.gen(function* () {
          const neverHealthy = new Set<string>();
          const route = defaultRoute({ neverHealthy });
          const { layer, out, child } = yield* setup({
            route: (args) => {
              if (args[0] === "create") {
                const name = containerNameFromCreateArgs(args);
                if (name.includes("_auth_")) neverHealthy.add(name);
              }
              return route(args);
            },
            httpClientLayer: unusedHttpClientLayer,
          });

          // `edge-runtime` also excluded so its own HTTP readiness probe never reaches
          // `unusedHttpClientLayer` — this scenario is only about the Docker-inspect health path.
          const exit = yield* Effect.exit(
            start(flags({ exclude: ["postgrest", "edge-runtime"] })).pipe(Effect.provide(layer)),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain("HealthCheckTimeoutError");
          }
          expect(out.stderrText).not.toContain("Started");
          expect(rollbackWasAttempted(child.spawned)).toBe(true);
        }).pipe(Effect.provide(BunServices.layer)),
      45_000,
    );
  });

  // Real time, not `it.effect`/`TestClock`: genuine async I/O deep inside the forked effect
  // (HTTP requests and `resolveDbImage`'s file read) needs real Node
  // event-loop turns to settle, so a virtualized clock would never let the fiber reach the
  // health-check phase. Exercises the real 30s `serviceTimeout` bulk health-check wait, hence
  // the generous timeout.
  it.live(
    "exits 0 on --ignore-health-check when a non-Postgres container never turns healthy, without rolling back",
    () =>
      Effect.gen(function* () {
        const neverHealthy = new Set<string>();
        const route = defaultRoute({ neverHealthy });
        const { layer, out, child, analytics } = yield* setup({
          route: (args) => {
            if (args[0] === "create") {
              const name = containerNameFromCreateArgs(args);
              if (name.includes("_auth_")) neverHealthy.add(name);
            }
            // The timeout path dumps this container's logs; scripting the
            // `exec format error` signature into them exercises the whole
            // recovery-advice wiring (name -> resolved image -> rendered hint).
            if (args[0] === "logs" && (args[1] ?? "").includes("_auth_")) {
              return { stdout: ["exec /usr/local/bin/auth: exec format error\n"] };
            }
            return route(args);
          },
          // Sidesteps the PostgREST/Edge Runtime HTTP-HEAD readiness probes, so this only
          // exercises the Docker-inspect health path.
          httpClientLayer: unusedHttpClientLayer,
        });

        yield* start(
          flags({ exclude: ["postgrest", "edge-runtime"], ignoreHealthCheck: true }),
        ).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("is not ready");
        expect(out.stderrText).toContain("Started");
        expect(rollbackWasAttempted(child.spawned)).toBe(false);
        expect(out.stderrText).toContain("supabase_auth_demo container is not ready");
        expect(out.stderrText).toContain("docker image rm -f public.ecr.aws/supabase/gotrue:");
        // `cli_stack_started` never fires on the ignored-unhealthy fallthrough — only a genuine
        // bulk health-check success reaches that capture.
        expect(analytics.captured.some((c) => c.event === "cli_stack_started")).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
    45_000,
  );

  describe("--ignore-health-check storage-only recheck and seed on a fresh volume", () => {
    it.live(
      "recheck-and-seeds buckets when storage itself is healthy, then still downgrades the original error to a warning",
      () =>
        Effect.gen(function* () {
          const http = mockStorageBucketHttpClient();
          const neverHealthy = new Set<string>();
          const route = freshVolumeRoute(defaultRoute({ neverHealthy }));
          const { layer, out, child, analytics } = yield* setup({
            configContents: 'project_id = "demo"\n[storage.buckets.avatars]\npublic = false\n',
            route: (args) => {
              if (args[0] === "create") {
                const name = containerNameFromCreateArgs(args);
                if (name.includes("_auth_")) neverHealthy.add(name);
              }
              return route(args);
            },
            httpClientLayer: http.layer,
          });

          yield* start(
            flags({ exclude: ["postgrest", "edge-runtime"], ignoreHealthCheck: true }),
          ).pipe(Effect.provide(layer));
          expect(http.createdBucketRequests).toHaveLength(1);
          expect(out.stderrText).toContain("is not ready");
          expect(out.stderrText).toContain("Started");
          expect(rollbackWasAttempted(child.spawned)).toBe(false);
          expect(analytics.captured.some((c) => c.event === "cli_stack_started")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
      45_000,
    );

    it.live(
      "keeps a vector bucket missing from config.toml during the recheck-and-seed (prune declines without consent)",
      () =>
        Effect.gen(function* () {
          const http = mockStorageVectorHttpClient(["embeddings", "stale-vec"]);
          const neverHealthy = new Set<string>();
          const route = freshVolumeRoute(defaultRoute({ neverHealthy }));
          const { layer, out, child, analytics } = yield* setup({
            configContents:
              'project_id = "demo"\n[storage.vector]\nenabled = true\n[storage.vector.buckets.embeddings]\n',
            route: (args) => {
              if (args[0] === "create") {
                const name = containerNameFromCreateArgs(args);
                if (name.includes("_auth_")) neverHealthy.add(name);
              }
              return route(args);
            },
            httpClientLayer: http.layer,
          });
          // A truthy ambient `SUPABASE_YES` would auto-confirm the prune.
          return yield* withEnvVar(
            "SUPABASE_YES",
            undefined,
            Effect.gen(function* () {
              yield* start(
                flags({ exclude: ["postgrest", "edge-runtime"], ignoreHealthCheck: true }),
              );
              // Only the downgrade branch seeds while the original health error is still a
              // warning and `cli_stack_started` never fires — the main path requires a healthy
              // bulk check, which captures that event.
              expect(out.stderrText).toContain("is not ready");
              expect(analytics.captured.some((c) => c.event === "cli_stack_started")).toBe(false);
              expect(rollbackWasAttempted(child.spawned)).toBe(false);
              expect(http.vectorListCalls).toBe(1);
              expect(http.deletedVectorBuckets).toHaveLength(0);
              expect(out.stderrText).toContain("Keeping vector bucket");
              expect(out.stderrText).toContain("stale-vec");
              expect(out.stderrText).not.toContain("Do you want to prune it?");
            }).pipe(Effect.provide(layer)),
          );
        }).pipe(Effect.provide(BunServices.layer)),
      45_000,
    );

    it.live(
      "a bucket-seed failure during the recheck becomes a hard failure with rollback, replacing the original health error",
      () =>
        Effect.gen(function* () {
          const failingBucketCreateHttpClientLayer = Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              if (request.method === "GET" && request.url.includes("/storage/v1/bucket")) {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response("[]", {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    }),
                  ),
                );
              }
              if (request.method === "POST" && request.url.includes("/storage/v1/bucket")) {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response("internal error", { status: 500 }),
                  ),
                );
              }
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
              );
            }),
          );
          const neverHealthy = new Set<string>();
          const route = freshVolumeRoute(defaultRoute({ neverHealthy }));
          const { layer, child, analytics } = yield* setup({
            configContents: 'project_id = "demo"\n[storage.buckets.avatars]\npublic = false\n',
            route: (args) => {
              if (args[0] === "create") {
                const name = containerNameFromCreateArgs(args);
                if (name.includes("_auth_")) neverHealthy.add(name);
              }
              return route(args);
            },
            httpClientLayer: failingBucketCreateHttpClientLayer,
          });

          const exit = yield* Effect.exit(
            start(flags({ exclude: ["postgrest", "edge-runtime"], ignoreHealthCheck: true })).pipe(
              Effect.provide(layer),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = Cause.pretty(exit.cause);
            expect(serialized).toContain("StorageGatewayStatusError");
            // The seed error replaces the original health-check timeout entirely.
            const failures = exit.cause.reasons.filter(Cause.isFailReason);
            expect(failures.length).toBeGreaterThan(0);
            expect(
              failures.some(({ error }) => Predicate.isTagged(error, "StorageGatewayStatusError")),
            ).toBe(true);
            expect(
              failures.some(({ error }) => Predicate.isTagged(error, "HealthCheckTimeoutError")),
            ).toBe(false);
          }
          expect(rollbackWasAttempted(child.spawned)).toBe(true);
          expect(analytics.captured.some((c) => c.event === "cli_stack_started")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
      45_000,
    );

    // Both the main bulk health check (auth) and this storage-only recheck run out their own
    // full ~30s real-time retry budget here, hence the doubled timeout relative to every other
    // real-time health-check test in this file.
    it.live(
      "falls through to the original warning without attempting to seed when the storage recheck itself never turns healthy",
      () =>
        Effect.gen(function* () {
          const neverHealthy = new Set<string>();
          const route = freshVolumeRoute(defaultRoute({ neverHealthy }));
          const http = mockStorageBucketHttpClient();
          const { layer, out, child, analytics } = yield* setup({
            configContents: 'project_id = "demo"\n[storage.buckets.avatars]\npublic = false\n',
            route: (args) => {
              if (args[0] === "create") {
                const name = containerNameFromCreateArgs(args);
                // Both auth (fails the main bulk check) and storage (fails the
                // narrower recheck) never turn healthy.
                if (name.includes("_auth_") || name.includes("_storage_")) neverHealthy.add(name);
              }
              return route(args);
            },
            httpClientLayer: http.layer,
          });

          yield* start(
            flags({ exclude: ["postgrest", "edge-runtime"], ignoreHealthCheck: true }),
          ).pipe(Effect.provide(layer));
          expect(http.createdBucketRequests).toHaveLength(0);
          expect(out.stderrText).toContain("is not ready");
          expect(out.stderrText).toContain("Started");
          expect(rollbackWasAttempted(child.spawned)).toBe(false);
          expect(analytics.captured.some((c) => c.event === "cli_stack_started")).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
      90_000,
    );
  });

  describe("--network-id", () => {
    it.live("overrides the generated network name and every container's --network flag", () =>
      Effect.gen(function* () {
        const { layer, child } = yield* setup({ networkId: Option.some("custom-net") });

        yield* start(flags()).pipe(Effect.provide(layer));
        const networkCreate = child.spawned.find(
          (s) => s.args[0] === "network" && s.args[1] === "create",
        );
        expect(networkCreate?.args.at(-1)).toBe("custom-net");
        const kongCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_kong_"),
        );
        const networkFlagIndex = kongCreate?.args.indexOf("--network") ?? -1;
        expect(kongCreate?.args[networkFlagIndex + 1]).toBe("custom-net");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("never spawns a create for a pre-created --network-id network", () =>
      Effect.gen(function* () {
        const base = defaultRoute();
        const route = (args: ReadonlyArray<string>): RouteResult => {
          if (args[0] === "network" && args[1] === "inspect") return { exitCode: 0 };
          if (args[0] === "network" && args[1] === "create") {
            return { exitCode: 1, stderr: ["error during connect: write: broken pipe"] };
          }
          return base(args);
        };
        const { layer, child } = yield* setup({ networkId: Option.some("custom-net"), route });

        yield* start(flags()).pipe(Effect.provide(layer));
        expect(child.spawned.some((s) => s.args[0] === "network" && s.args[1] === "create")).toBe(
          false,
        );
        expect(
          child.spawned.some(
            (s) => s.args[0] === "network" && s.args[1] === "inspect" && s.args[2] === "custom-net",
          ),
        ).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("falls back to SUPABASE_NETWORK_ID when the flag itself is omitted", () =>
      withEnvVar(
        "SUPABASE_NETWORK_ID",
        "env-net",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup();

            yield* start(flags()).pipe(Effect.provide(layer));
            const networkCreate = child.spawned.find(
              (s) => s.args[0] === "network" && s.args[1] === "create",
            );
            expect(networkCreate?.args.at(-1)).toBe("env-net");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_API_PORT override", () => {
    it.live("publishes Kong on the env-overridden API port, not config.api.port", () =>
      withEnvVar(
        "SUPABASE_API_PORT",
        "61234",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup();

            yield* start(flags()).pipe(Effect.provide(layer));
            const kongCreate = child.spawned.find(
              (s) =>
                s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_kong_"),
            );
            expect(kongCreate?.args).toContain("61234:8000");
            expect(kongCreate?.args).not.toContain("54321:8000");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("raw container environment overrides", () => {
    for (const scenario of [
      {
        name: "forwards captured ambient values",
        snapshot: true,
        ambientKong: "8",
        ambientVector: "false",
        project: undefined,
        kong: "8",
        vector: "false",
      },
      {
        name: "preserves captured empty ambient values",
        snapshot: true,
        ambientKong: "",
        ambientVector: "",
        project: undefined,
        kong: "",
        vector: "",
      },
      {
        name: "preserves shell precedence over project dotenv values",
        ambientKong: "8",
        ambientVector: "false",
        project: "KONG_NGINX_WORKER_PROCESSES=4\nVECTOR_ENABLED=true\n",
        kong: "8",
        vector: "false",
      },
      {
        name: "preserves shell precedence over empty project dotenv values",
        ambientKong: "8",
        ambientVector: "false",
        project: "KONG_NGINX_WORKER_PROCESSES=\nVECTOR_ENABLED=\n",
        kong: "8",
        vector: "false",
      },
      {
        name: "preserves empty shell values over project dotenv values",
        ambientKong: "",
        ambientVector: "",
        project: "KONG_NGINX_WORKER_PROCESSES=4\nVECTOR_ENABLED=true\n",
        kong: "",
        vector: "",
      },
      {
        name: "uses project dotenv values when shell values are absent",
        ambientKong: undefined,
        ambientVector: undefined,
        project: "KONG_NGINX_WORKER_PROCESSES=4\nVECTOR_ENABLED=false\n",
        kong: "4",
        vector: "false",
      },
      {
        name: "preserves empty project dotenv values when shell values are absent",
        ambientKong: undefined,
        ambientVector: undefined,
        project: "KONG_NGINX_WORKER_PROCESSES=\nVECTOR_ENABLED=\n",
        kong: "",
        vector: "",
      },
    ]) {
      it.live(scenario.name, () =>
        withEnvVar(
          "KONG_NGINX_WORKER_PROCESSES",
          scenario.ambientKong,
          withEnvVar(
            "VECTOR_ENABLED",
            scenario.ambientVector,
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const { layer, workdir, child } = yield* setup();
              if (scenario.project !== undefined) {
                yield* fs.writeFileString(path.join(workdir, "supabase", ".env"), scenario.project);
              }
              const run = start(flags()).pipe(Effect.provide(layer));
              yield* "snapshot" in scenario
                ? withEnvVar(
                    "KONG_NGINX_WORKER_PROCESSES",
                    undefined,
                    withEnvVar("VECTOR_ENABLED", undefined, run),
                  )
                : run;
              const kong = child.spawned.find(
                (s) =>
                  s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_kong_"),
              );
              const storage = child.spawned.find(
                (s) =>
                  s.args[0] === "create" &&
                  containerNameFromCreateArgs(s.args).includes("_storage_"),
              );
              expect(kong).toBeDefined();
              expect(storage).toBeDefined();
              expect(kong?.env["KONG_NGINX_WORKER_PROCESSES"]).toBe(scenario.kong);
              expect(storage?.env["VECTOR_ENABLED"]).toBe(scenario.vector);
            }),
          ),
        ).pipe(Effect.provide(BunServices.layer)),
      );
    }
  });

  describe("storage migration pin", () => {
    it.live(
      "threads a linked project's supabase/.temp/storage-migration pin into DB_MIGRATIONS_FREEZE_AT",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { layer, workdir, child } = yield* setup();
          yield* fs.makeDirectory(path.join(workdir, "supabase", ".temp"), { recursive: true });
          yield* fs.writeFileString(
            path.join(workdir, "supabase", ".temp", "storage-migration"),
            "20240102030405\n",
          );

          yield* start(flags()).pipe(Effect.provide(layer));
          const storageCreate = child.spawned.find(
            (s) =>
              s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_storage_"),
          );
          expect(storageCreate?.env["DB_MIGRATIONS_FREEZE_AT"]).toBe("20240102030405");
        }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live('resolves to "" when no pin file exists', () =>
      Effect.gen(function* () {
        const { layer, child } = yield* setup();

        yield* start(flags()).pipe(Effect.provide(layer));
        const storageCreate = child.spawned.find(
          (s) =>
            s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_storage_"),
        );
        expect(storageCreate?.env["DB_MIGRATIONS_FREEZE_AT"]).toBe("");
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("linked service version pins", () => {
    it.live(
      "resolves a supabase/.temp/storage-version pin into the pulled/created storage image tag",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { layer, workdir, child } = yield* setup();
          yield* fs.makeDirectory(path.join(workdir, "supabase", ".temp"), { recursive: true });
          yield* fs.writeFileString(
            path.join(workdir, "supabase", ".temp", "storage-version"),
            "1.2.3\n",
          );

          yield* start(flags()).pipe(Effect.provide(layer));
          const storageImageInspect = child.spawned.find(
            (s) =>
              s.args[0] === "image" &&
              s.args[1] === "inspect" &&
              (s.args[2] ?? "").includes("storage"),
          );
          expect(storageImageInspect?.args[2]).toMatch(/:1\.2\.3$/);
        }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("db.root_key", () => {
    it.live(
      "delivers a configured db.root_key into the Postgres container's pgsodium root key via `docker cp`, never leaving it on host disk",
      () =>
        Effect.gen(function* () {
          const copied = new Map<string, string>();
          const { layer, child } = yield* setup({
            configContents: 'project_id = "demo"\n[db]\nroot_key = "custom-root-key-value"\n',
            onSecretCopy: (containerPath, content) => {
              copied.set(containerPath, content);
            },
          });

          yield* start(flags()).pipe(Effect.provide(layer));
          const containerName = serviceContainerName("db", "demo");
          expect(copied.get("/etc/postgresql-custom/pgsodium_root.key")).toBe(
            "custom-root-key-value",
          );
          const dbCp = child.spawned.find(
            (s) => s.args[0] === "cp" && s.args[2] === `${fakeContainerId(containerName)}:/`,
          );
          expect(dbCp?.args).toEqual(["cp", "-", `${fakeContainerId(containerName)}:/`]);
          expect(dbCp?.args.some((arg) => arg.includes("custom-root-key-value"))).toBe(false);
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(true);
        }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("container-not-found stderr shapes", () => {
    it.live(
      "brings up the stack when the DB container's inspect reports 'No such object' instead of 'No such container'",
      () =>
        Effect.gen(function* () {
          const created = new Set<string>();
          const route = (args: ReadonlyArray<string>): RouteResult => {
            if (args[0] === "container" && args[1] === "inspect") {
              const id = args[2] ?? "";
              if (!created.has(id)) {
                return { exitCode: 1, stderr: [`Error: no such object: ${id}`] };
              }
              return { stdout: [HEALTHY_STATE] };
            }
            if (args[0] === "image" && args[1] === "inspect") return { exitCode: 0 };
            if (args[0] === "network" && args[1] === "create") return { exitCode: 0 };
            if (args[0] === "volume" && args[1] === "create") return { exitCode: 0 };
            if (args[0] === "context" && args[1] === "inspect") return { exitCode: 1 };
            if (args[0] === "create") {
              const name = containerNameFromCreateArgs(args);
              created.add(name);
              return { stdout: [name] };
            }
            if (args[0] === "start") return { exitCode: 0 };
            if (args[0] === "logs") return { exitCode: 0 };
            if (args[0] === "ps") return { stdout: [] };
            return { exitCode: 0 };
          };
          const { layer, child } = yield* setup({ route });

          yield* start(flags()).pipe(Effect.provide(layer));
          const createdNames = createdContainerNames(child.spawned);
          expect(createdNames.some((name) => name.includes("_db_"))).toBe(true);
        }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("Linux host-gateway mapping", () => {
    it.live("adds --add-host host.docker.internal:host-gateway on Linux", () =>
      Effect.gen(function* () {
        const { layer, child } = yield* setup();

        yield* start(flags()).pipe(Effect.provide(layer));
        const kongCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_kong_"),
        );
        const addHostIndex = kongCreate?.args.indexOf("--add-host") ?? -1;
        expect(kongCreate?.args[addHostIndex + 1]).toBe("host.docker.internal:host-gateway");
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("auth.email.smtp table-present default", () => {
    it.live(
      "uses the configured SMTP server (not Mailpit) when [auth.email.smtp] omits enabled",
      () =>
        Effect.gen(function* () {
          const { layer, child } = yield* setup({
            configContents:
              'project_id = "demo"\n[auth.email.smtp]\nhost = "smtp.example.com"\nport = 587\nuser = "smtp-user"\npass = "smtp-pass"\nadmin_email = "admin@example.com"\n',
          });

          yield* start(flags()).pipe(Effect.provide(layer));
          const gotrueCreate = child.spawned.find(
            (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
          );
          expect(gotrueCreate?.env["GOTRUE_SMTP_HOST"]).toBe("smtp.example.com");
          expect(gotrueCreate?.env["GOTRUE_SMTP_PORT"]).toBe("587");
        }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("custom auth.external providers", () => {
    it.live("emits GOTRUE_EXTERNAL_* env vars for a provider outside the fixed schema set", () =>
      Effect.gen(function* () {
        const { layer, child } = yield* setup({
          configContents:
            'project_id = "demo"\n[auth.external.my_oidc]\nenabled = true\nclient_id = "custom-client-id"\nsecret = "custom-secret"\n',
        });

        yield* start(flags()).pipe(Effect.provide(layer));
        const gotrueCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
        );
        expect(gotrueCreate?.env["GOTRUE_EXTERNAL_MY_OIDC_ENABLED"]).toBe("true");
        expect(gotrueCreate?.env["GOTRUE_EXTERNAL_MY_OIDC_CLIENT_ID"]).toBe("custom-client-id");
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_LOCAL_SMTP_ADMIN_EMAIL / SUPABASE_LOCAL_SMTP_SENDER_NAME overrides", () => {
    it.live("honors env overrides for the Mailpit fallback's admin email and sender name", () =>
      withEnvVar(
        "SUPABASE_LOCAL_SMTP_ADMIN_EMAIL",
        "override-admin@example.com",
        withEnvVar(
          "SUPABASE_LOCAL_SMTP_SENDER_NAME",
          "Override Sender",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              yield* start(flags()).pipe(Effect.provide(layer));
              const gotrueCreate = child.spawned.find(
                (s) =>
                  s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
              );
              expect(gotrueCreate?.env["GOTRUE_SMTP_ADMIN_EMAIL"]).toBe(
                "override-admin@example.com",
              );
              expect(gotrueCreate?.env["GOTRUE_SMTP_SENDER_NAME"]).toBe("Override Sender");
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_LOCAL_SMTP_SMTP_PORT override", () => {
    it.live(
      "fails with a typed config error, before any container is created, on an invalid SUPABASE_LOCAL_SMTP_SMTP_PORT",
      () =>
        withEnvVar(
          "SUPABASE_LOCAL_SMTP_SMTP_PORT",
          "not-a-port",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                expect(Cause.pretty(exit.cause)).toContain("StartInvalidConfigError");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_AUTH_SMS_<PROVIDER>_* overrides", () => {
    it.live("honors env overrides enabling Twilio SMS even when config.toml has it disabled", () =>
      withEnvVar(
        "SUPABASE_AUTH_SMS_TWILIO_ENABLED",
        "true",
        withEnvVar(
          "SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID",
          "override-account-sid",
          withEnvVar(
            "SUPABASE_AUTH_SMS_TWILIO_MESSAGE_SERVICE_SID",
            "override-message-service-sid",
            withEnvVar(
              "SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN",
              "override-auth-token",
              Effect.gen(function* () {
                const { layer, child } = yield* setup({
                  configContents: 'project_id = "demo"\n[auth.sms.twilio]\nenabled = false\n',
                });

                yield* start(flags()).pipe(Effect.provide(layer));
                const gotrueCreate = child.spawned.find(
                  (s) =>
                    s.args[0] === "create" &&
                    containerNameFromCreateArgs(s.args).includes("_auth_"),
                );
                expect(gotrueCreate?.env["GOTRUE_SMS_PROVIDER"]).toBe("twilio");
                expect(gotrueCreate?.env["GOTRUE_SMS_TWILIO_ACCOUNT_SID"]).toBe(
                  "override-account-sid",
                );
                expect(gotrueCreate?.env["GOTRUE_SMS_TWILIO_MESSAGE_SERVICE_SID"]).toBe(
                  "override-message-service-sid",
                );
                expect(gotrueCreate?.env["GOTRUE_SMS_TWILIO_AUTH_TOKEN"]).toBe(
                  "override-auth-token",
                );
              }).pipe(Effect.provide(BunServices.layer)),
            ),
          ),
        ),
      ),
    );

    it.live(
      "honors SUPABASE_AUTH_SMS_ENABLE_SIGNUP and SUPABASE_AUTH_SMS_MAX_FREQUENCY in GoTrue's env",
      () =>
        withEnvVar(
          "SUPABASE_AUTH_SMS_ENABLE_SIGNUP",
          "true",
          withEnvVar(
            "SUPABASE_AUTH_SMS_MAX_FREQUENCY",
            "10s",
            Effect.suspend(() => {
              return Effect.gen(function* () {
                const { layer, child } = yield* setup({
                  configContents:
                    'project_id = "demo"\n[auth.sms.twilio]\nenabled = true\naccount_sid = "AC123"\nauth_token = "test-auth-token"\nmessage_service_sid = "MG123"\n',
                });

                yield* start(flags()).pipe(Effect.provide(layer));
                const gotrueCreate = child.spawned.find(
                  (s) =>
                    s.args[0] === "create" &&
                    containerNameFromCreateArgs(s.args).includes("_auth_"),
                );
                expect(gotrueCreate?.env["GOTRUE_EXTERNAL_PHONE_ENABLED"]).toBe("true");
                expect(gotrueCreate?.env["GOTRUE_SMS_MAX_FREQUENCY"]).toBe("10s");
              }).pipe(Effect.provide(BunServices.layer));
            }),
          ),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "disables phone login and warns when enable_signup is true with no SMS provider enabled",
      () =>
        withEnvVar(
          "SUPABASE_AUTH_SMS_ENABLE_SIGNUP",
          "true",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child, out } = yield* setup();

              yield* start(flags()).pipe(Effect.provide(layer));
              const gotrueCreate = child.spawned.find(
                (s) =>
                  s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
              );
              expect(gotrueCreate?.env["GOTRUE_EXTERNAL_PHONE_ENABLED"]).toBe("false");
              expect(out.stderrText).toContain(
                "WARN: no SMS provider is enabled. Disabling phone login",
              );
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_AUTH_EMAIL_* overrides", () => {
    it.live(
      "honors SUPABASE_AUTH_EMAIL_ENABLE_SIGNUP and SUPABASE_AUTH_EMAIL_OTP_LENGTH in GoTrue's env",
      () =>
        withEnvVar(
          "SUPABASE_AUTH_EMAIL_ENABLE_SIGNUP",
          "false",
          withEnvVar(
            "SUPABASE_AUTH_EMAIL_OTP_LENGTH",
            "8",
            Effect.suspend(() => {
              return Effect.gen(function* () {
                const { layer, child } = yield* setup();

                yield* start(flags()).pipe(Effect.provide(layer));
                const gotrueCreate = child.spawned.find(
                  (s) =>
                    s.args[0] === "create" &&
                    containerNameFromCreateArgs(s.args).includes("_auth_"),
                );
                expect(gotrueCreate?.env["GOTRUE_EXTERNAL_EMAIL_ENABLED"]).toBe("false");
                expect(gotrueCreate?.env["GOTRUE_MAILER_OTP_LENGTH"]).toBe("8");
              }).pipe(Effect.provide(BunServices.layer));
            }),
          ),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "honors SUPABASE_AUTH_EMAIL_TEMPLATE_<NAME>_SUBJECT in GoTrue's mailer subject env",
      () =>
        withEnvVar(
          "SUPABASE_AUTH_EMAIL_TEMPLATE_CONFIRMATION_SUBJECT",
          "Override subject",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const { layer, workdir, child } = yield* setup({
                configContents:
                  'project_id = "demo"\n[auth.email.template.confirmation]\ncontent_path = "./templates/confirmation.html"\n',
              });
              yield* fs.makeDirectory(path.join(workdir, "templates"), { recursive: true });
              yield* fs.writeFileString(
                path.join(workdir, "templates", "confirmation.html"),
                "<html></html>",
              );

              yield* start(flags()).pipe(Effect.provide(layer));
              const gotrueCreate = child.spawned.find(
                (s) =>
                  s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
              );
              expect(gotrueCreate?.env["GOTRUE_MAILER_SUBJECTS_CONFIRMATION"]).toBe(
                "Override subject",
              );
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails fast on SUPABASE_AUTH_EMAIL_TEMPLATE_<NAME>_CONTENT with no content_path configured, matching Go's Config.Validate",
      () =>
        withEnvVar(
          "SUPABASE_AUTH_EMAIL_TEMPLATE_CONFIRMATION_CONTENT",
          "<html>Hi</html>",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({
                configContents: 'project_id = "demo"\n[auth.email.template.confirmation]\n',
              });

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
                expect(serialized).toContain(
                  "Invalid config for auth.email.template.confirmation.content: please use content_path instead",
                );
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_DB_PORT override", () => {
    it.live("publishes Postgres on the env-overridden DB port, not config.db.port", () =>
      withEnvVar(
        "SUPABASE_DB_PORT",
        "54329",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup();

            yield* start(flags()).pipe(Effect.provide(layer));
            const dbCreate = child.spawned.find(
              (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_db_"),
            );
            expect(dbCreate?.args).toContain("54329:5432");
            expect(dbCreate?.args).not.toContain("54322:5432");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_DB_SETTINGS_* env overrides", () => {
    it.live("honors SUPABASE_DB_SETTINGS_SHARED_BUFFERS in the rendered postgresql.conf", () =>
      withEnvVar(
        "SUPABASE_DB_SETTINGS_SHARED_BUFFERS",
        "256MB",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup();

            yield* start(flags()).pipe(Effect.provide(layer));
            const dbCreate = child.spawned.find(
              (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_db_"),
            );
            expect(dbCreate?.args.some((arg) => arg.includes("shared_buffers = '256MB'"))).toBe(
              true,
            );
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("storage feature env overrides", () => {
    it.live("honors SUPABASE_STORAGE_S3_PROTOCOL_ENABLED and SUPABASE_STORAGE_VECTOR_ENABLED", () =>
      withEnvVar(
        "SUPABASE_STORAGE_S3_PROTOCOL_ENABLED",
        "false",
        withEnvVar(
          "SUPABASE_STORAGE_VECTOR_ENABLED",
          "false",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              yield* start(flags()).pipe(Effect.provide(layer));
              const storageCreate = child.spawned.find(
                (s) =>
                  s.args[0] === "create" &&
                  containerNameFromCreateArgs(s.args).includes("_storage_"),
              );
              expect(storageCreate?.env["S3_PROTOCOL_ENABLED"]).toBe("false");
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_ANALYTICS_* env overrides", () => {
    it.live("honors SUPABASE_ANALYTICS_BACKEND/_GCP_* for both Logflare and Studio", () =>
      withEnvVar(
        "SUPABASE_ANALYTICS_BACKEND",
        "bigquery",
        withEnvVar(
          "SUPABASE_ANALYTICS_GCP_PROJECT_ID",
          "env-gcp-project",
          withEnvVar(
            "SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER",
            "987654321",
            withEnvVar(
              "SUPABASE_ANALYTICS_GCP_JWT_PATH",
              "gcp-key.json",
              Effect.suspend(() => {
                return Effect.gen(function* () {
                  const { layer, child } = yield* setup();

                  yield* start(flags()).pipe(Effect.provide(layer));
                  const logflareCreate = child.spawned.find(
                    (s) =>
                      s.args[0] === "create" &&
                      containerNameFromCreateArgs(s.args).includes("_analytics_"),
                  );
                  expect(logflareCreate?.env["GOOGLE_PROJECT_ID"]).toBe("env-gcp-project");
                  expect(logflareCreate?.env["GOOGLE_PROJECT_NUMBER"]).toBe("987654321");
                  const studioCreate = child.spawned.find(
                    (s) =>
                      s.args[0] === "create" &&
                      containerNameFromCreateArgs(s.args).includes("_studio_"),
                  );
                  expect(studioCreate?.env["NEXT_ANALYTICS_BACKEND_PROVIDER"]).toBe("bigquery");
                }).pipe(Effect.provide(BunServices.layer));
              }),
            ),
          ),
        ),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("auth.* env overrides reach GoTrue's container", () => {
    it.live("honors SUPABASE_AUTH_ENABLE_SIGNUP for GOTRUE_DISABLE_SIGNUP", () =>
      withEnvVar(
        "SUPABASE_AUTH_ENABLE_SIGNUP",
        "false",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup();

            yield* start(flags()).pipe(Effect.provide(layer));
            const gotrueCreate = child.spawned.find(
              (s) =>
                s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
            );
            expect(gotrueCreate?.env["GOTRUE_DISABLE_SIGNUP"]).toBe("true");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_EDGE_RUNTIME_DENO_VERSION override", () => {
    it.live("resolves the Deno 1 edge-runtime image tag, not the Deno 2 default", () =>
      withEnvVar(
        "SUPABASE_EDGE_RUNTIME_DENO_VERSION",
        "1",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup();

            yield* start(flags()).pipe(Effect.provide(layer));
            const edgeRuntimeImageInspect = child.spawned.find(
              (s) =>
                s.args[0] === "image" &&
                s.args[1] === "inspect" &&
                (s.args[2] ?? "").includes("edge-runtime"),
            );
            expect(edgeRuntimeImageInspect?.args[2]).toBe(
              "public.ecr.aws/supabase/edge-runtime:v1.68.4",
            );
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_REALTIME_* env overrides", () => {
    it.live(
      "honors SUPABASE_REALTIME_IP_VERSION/_MAX_HEADER_LENGTH for both the long-running container and the PG15+ setup job",
      () =>
        withEnvVar(
          "SUPABASE_REALTIME_IP_VERSION",
          "IPv6",
          withEnvVar(
            "SUPABASE_REALTIME_MAX_HEADER_LENGTH",
            "8192",
            Effect.suspend(() => {
              return Effect.gen(function* () {
                const { layer, child } = yield* setup({
                  route: freshVolumeRoute(defaultRoute()),
                });

                yield* start(flags({ exclude: ["edge-runtime"] })).pipe(Effect.provide(layer));
                const realtimeCreate = child.spawned.find(
                  (s) =>
                    s.args[0] === "create" &&
                    containerNameFromCreateArgs(s.args).includes("_realtime_"),
                );
                expect(realtimeCreate?.env["ERL_AFLAGS"]).toBe("-proto_dist inet6_tcp");
                expect(realtimeCreate?.env["MAX_HEADER_LENGTH"]).toBe("8192");

                // The first of the three PG15+ one-shot migrate jobs (realtime, storage, auth
                // order) — see the "fresh volume: DB setup" describe block's own
                // `dbSetupJobCalls` helper for the same `run --rm` shape.
                const realtimeSetupJob = child.spawned.find(
                  (s) => s.args[0] === "run" && s.args[1] === "--rm",
                );
                expect(realtimeSetupJob?.env["ERL_AFLAGS"]).toBe("-proto_dist inet6_tcp");
                expect(realtimeSetupJob?.env["MAX_HEADER_LENGTH"]).toBe("8192");
              }).pipe(Effect.provide(BunServices.layer));
            }),
          ),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails with a typed config error, before any container is created, on an invalid SUPABASE_REALTIME_IP_VERSION",
      () =>
        withEnvVar(
          "SUPABASE_REALTIME_IP_VERSION",
          "IPv5",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                expect(Cause.pretty(exit.cause)).toContain("StartInvalidConfigError");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("Studio API URL normalization", () => {
    it.live(
      "rewrites the default studio.api_url to the Kong URL rather than passing it through raw",
      () =>
        Effect.gen(function* () {
          const { layer, child } = yield* setup();

          yield* start(flags()).pipe(Effect.provide(layer));
          const studioCreate = child.spawned.find(
            (s) =>
              s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_studio_"),
          );
          expect(studioCreate?.env["SUPABASE_PUBLIC_URL"]).toBe("http://127.0.0.1:54321");
          expect(studioCreate?.env["SUPABASE_PUBLIC_URL"]).not.toBe("http://127.0.0.1");
        }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_STORAGE_FILE_SIZE_LIMIT override", () => {
    it.live(
      "honors the override for both Storage's container and the fresh-volume migrate job",
      () =>
        withEnvVar(
          "SUPABASE_STORAGE_FILE_SIZE_LIMIT",
          "5MiB",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({ route: freshVolumeRoute(defaultRoute()) });

              yield* start(flags({ exclude: ["edge-runtime"] })).pipe(Effect.provide(layer));
              const storageCreate = child.spawned.find(
                (s) =>
                  s.args[0] === "create" &&
                  containerNameFromCreateArgs(s.args).includes("_storage_"),
              );
              expect(storageCreate?.env["FILE_SIZE_LIMIT"]).toBe(String(5 * 1024 * 1024));

              // Second of the three PG15+ one-shot migrate jobs (realtime, storage, auth order).
              const migrateJobs = child.spawned.filter(
                (s) => s.args[0] === "run" && s.args[1] === "--rm",
              );
              expect(migrateJobs[1]?.env["FILE_SIZE_LIMIT"]).toBe(String(5 * 1024 * 1024));
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION override", () => {
    it.live(
      "selects the OrioleDB Postgres image and enables the container's S3 env when set only via env",
      () =>
        withEnvVar(
          "SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION",
          "16.0.0.1",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              yield* start(flags()).pipe(Effect.provide(layer));
              const dbImageInspect = child.spawned.find(
                (s) =>
                  s.args[0] === "image" &&
                  s.args[1] === "inspect" &&
                  (s.args[2] ?? "").includes("postgres"),
              );
              expect(dbImageInspect?.args[2]).toContain("16.0.0.1-orioledb");

              const dbCreate = child.spawned.find(
                (s) =>
                  s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_db_"),
              );
              expect(dbCreate?.env["S3_ENABLED"]).toBe("true");
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("honors SUPABASE_EXPERIMENTAL_S3_HOST/_REGION/_ACCESS_KEY/_SECRET_KEY", () =>
      withEnvVar(
        "SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION",
        "16.0.0.1",
        withEnvVar(
          "SUPABASE_EXPERIMENTAL_S3_HOST",
          "env-s3-host",
          withEnvVar(
            "SUPABASE_EXPERIMENTAL_S3_REGION",
            "env-s3-region",
            withEnvVar(
              "SUPABASE_EXPERIMENTAL_S3_ACCESS_KEY",
              "env-s3-access-key",
              withEnvVar(
                "SUPABASE_EXPERIMENTAL_S3_SECRET_KEY",
                "env-s3-secret-key",
                Effect.suspend(() => {
                  return Effect.gen(function* () {
                    const { layer, child } = yield* setup();

                    yield* start(flags()).pipe(Effect.provide(layer));
                    const dbCreate = child.spawned.find(
                      (s) =>
                        s.args[0] === "create" &&
                        containerNameFromCreateArgs(s.args).includes("_db_"),
                    );
                    expect(dbCreate?.env["S3_HOST"]).toBe("env-s3-host");
                    expect(dbCreate?.env["S3_REGION"]).toBe("env-s3-region");
                    expect(dbCreate?.env["S3_ACCESS_KEY"]).toBe("env-s3-access-key");
                    expect(dbCreate?.env["S3_SECRET_KEY"]).toBe("env-s3-secret-key");
                  }).pipe(Effect.provide(BunServices.layer));
                }),
              ),
            ),
          ),
        ),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("Kong's embedded default TLS cert/key", () => {
    it.live(
      "writes the embedded default cert/key when TLS is unconfigured, never empty files",
      () =>
        Effect.gen(function* () {
          const copied = new Map<string, string>();
          const { layer, child } = yield* setup({
            onSecretCopy: (containerPath, content) => {
              copied.set(containerPath, content);
            },
          });

          yield* start(flags()).pipe(Effect.provide(layer));
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(true);
          expect(copied.get("/home/kong/localhost.crt")).toBe(KONG_LOCAL_TLS_CERT);
          expect(copied.get("/home/kong/localhost.key")).toBe(KONG_LOCAL_TLS_KEY);
        }).pipe(Effect.provide(BunServices.layer)),
    );

    // An empty but present `cert_path`/`key_path` is treated the same as absent — it must not
    // attempt a disk read.
    it.live(
      "falls back to the embedded default cert/key when cert_path/key_path are present but empty",
      () =>
        Effect.gen(function* () {
          const copied = new Map<string, string>();
          const { layer, child } = yield* setup({
            configContents:
              'project_id = "demo"\n[api.tls]\nenabled = true\ncert_path = ""\nkey_path = ""\n',
            onSecretCopy: (containerPath, content) => {
              copied.set(containerPath, content);
            },
          });

          yield* start(flags()).pipe(Effect.provide(layer));
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(true);
          expect(copied.get("/home/kong/localhost.crt")).toBe(KONG_LOCAL_TLS_CERT);
          expect(copied.get("/home/kong/localhost.key")).toBe(KONG_LOCAL_TLS_KEY);
        }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_API_TLS_CERT_PATH/_KEY_PATH overrides", () => {
    it.live("reads the env-overridden cert/key paths for Kong, not the (absent) TOML fields", () =>
      withEnvVar(
        "SUPABASE_API_TLS_CERT_PATH",
        "certs/env-server.crt",
        withEnvVar(
          "SUPABASE_API_TLS_KEY_PATH",
          "certs/env-server.key",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const copied = new Map<string, string>();
              const { layer, workdir, child } = yield* setup({
                configContents: 'project_id = "demo"\n[api.tls]\nenabled = true\n',
                onSecretCopy: (containerPath, content) => {
                  copied.set(containerPath, content);
                },
              });
              yield* fs.makeDirectory(path.join(workdir, "supabase", "certs"), {
                recursive: true,
              });
              yield* fs.writeFileString(
                path.join(workdir, "supabase", "certs", "env-server.crt"),
                "-----BEGIN CERTIFICATE-----env-cert",
              );
              yield* fs.writeFileString(
                path.join(workdir, "supabase", "certs", "env-server.key"),
                "-----BEGIN PRIVATE KEY-----env-key",
              );

              yield* start(flags()).pipe(Effect.provide(layer));
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(true);
              expect(copied.get("/home/kong/localhost.crt")).toBe(
                "-----BEGIN CERTIFICATE-----env-cert",
              );
              expect(copied.get("/home/kong/localhost.key")).toBe(
                "-----BEGIN PRIVATE KEY-----env-key",
              );
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_API_ENABLED override", () => {
    // The entire TLS cert/key disk read is nested inside the API-enabled check, so when API is
    // disabled, Kong keeps its embedded default cert/key regardless of
    // `api.tls.enabled`/cert_path/key_path.
    it.live(
      "skips the configured cert/key read for Kong when API is disabled only via env override",
      () =>
        withEnvVar(
          "SUPABASE_API_ENABLED",
          "false",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const copied = new Map<string, string>();
              const { layer, workdir, child } = yield* setup({
                configContents: 'project_id = "demo"\n[api.tls]\nenabled = true\n',
                onSecretCopy: (containerPath, content) => {
                  copied.set(containerPath, content);
                },
              });
              yield* fs.makeDirectory(path.join(workdir, "supabase", "certs"), {
                recursive: true,
              });
              yield* fs.writeFileString(
                path.join(workdir, "supabase", "certs", "server.crt"),
                "-----BEGIN CERTIFICATE-----custom-cert",
              );
              yield* fs.writeFileString(
                path.join(workdir, "supabase", "certs", "server.key"),
                "-----BEGIN PRIVATE KEY-----custom-key",
              );

              yield* start(flags()).pipe(Effect.provide(layer));
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(true);
              expect(copied.get("/home/kong/localhost.crt")).toBe(KONG_LOCAL_TLS_CERT);
              expect(copied.get("/home/kong/localhost.key")).toBe(KONG_LOCAL_TLS_KEY);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails with a typed config error, before any container is created, on an invalid SUPABASE_API_ENABLED",
      () =>
        withEnvVar(
          "SUPABASE_API_ENABLED",
          "not-a-bool",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                expect(Cause.pretty(exit.cause)).toContain("StartInvalidConfigError");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_AUTH_JWT_EXPIRY reaches Postgres init", () => {
    it.live("honors the override for Postgres's JWT_EXP, not just GoTrue's GOTRUE_JWT_EXP", () =>
      withEnvVar(
        "SUPABASE_AUTH_JWT_EXPIRY",
        "7200",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup();

            yield* start(flags()).pipe(Effect.provide(layer));
            const dbCreate = child.spawned.find(
              (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_db_"),
            );
            expect(dbCreate?.env["JWT_EXP"]).toBe("7200");
            const gotrueCreate = child.spawned.find(
              (s) =>
                s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
            );
            expect(gotrueCreate?.env["GOTRUE_JWT_EXP"]).toBe("7200");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("encrypted secrets reach GoTrue's container", () => {
    it.live("decrypts an encrypted external OAuth provider secret (known provider)", () =>
      withEnvVar(
        "DOTENV_PRIVATE_KEY",
        VAULT_PRIVATE_KEY,
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup({
              configContents: `project_id = "demo"\n[auth.external.github]\nenabled = true\nclient_id = "gh-client-id"\nsecret = "${VAULT_ENCRYPTED}"\n`,
            });

            yield* start(flags()).pipe(Effect.provide(layer));
            const gotrueCreate = child.spawned.find(
              (s) =>
                s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
            );
            expect(gotrueCreate?.env["GOTRUE_EXTERNAL_GITHUB_SECRET"]).toBe("value");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "decrypts an encrypted external OAuth provider secret (custom/unmodeled provider)",
      () =>
        withEnvVar(
          "DOTENV_PRIVATE_KEY",
          VAULT_PRIVATE_KEY,
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({
                configContents: `project_id = "demo"\n[auth.external.my_oidc]\nenabled = true\nclient_id = "custom-client-id"\nsecret = "${VAULT_ENCRYPTED}"\n`,
              });

              yield* start(flags()).pipe(Effect.provide(layer));
              const gotrueCreate = child.spawned.find(
                (s) =>
                  s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
              );
              expect(gotrueCreate?.env["GOTRUE_EXTERNAL_MY_OIDC_SECRET"]).toBe("value");
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("decrypts an encrypted Twilio SMS auth_token", () =>
      withEnvVar(
        "DOTENV_PRIVATE_KEY",
        VAULT_PRIVATE_KEY,
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup({
              configContents: `project_id = "demo"\n[auth.sms.twilio]\nenabled = true\naccount_sid = "AC123"\nauth_token = "${VAULT_ENCRYPTED}"\nmessage_service_sid = "MG123"\n`,
            });

            yield* start(flags()).pipe(Effect.provide(layer));
            const gotrueCreate = child.spawned.find(
              (s) =>
                s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
            );
            expect(gotrueCreate?.env["GOTRUE_SMS_TWILIO_AUTH_TOKEN"]).toBe("value");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("Edge Runtime secrets", () => {
    it.live("resolves configured [edge_runtime.secrets] into the runtime's env, not dropped", () =>
      Effect.gen(function* () {
        const { layer, child } = yield* setup({
          configContents:
            'project_id = "demo"\n[edge_runtime.secrets]\nMY_SECRET = "shh-do-not-tell"\nmy_lower_secret = "keep-me"\nEMPTY_SECRET = ""\n',
        });

        const fs = yield* FileSystem.FileSystem;
        yield* start(flags()).pipe(Effect.provide(layer));
        const edgeRuntimeRunCall = child.spawned.find((s) => isEdgeRuntimeCreate(s.args));
        const args = edgeRuntimeRunCall?.args ?? [];
        const envFileIndex = args.indexOf("--env-file");
        const envFilePath = envFileIndex !== -1 ? args[envFileIndex + 1] : undefined;
        expect(envFilePath).toBeDefined();
        const envFileContent = yield* fs.readFileString(envFilePath ?? "");
        expect(envFileContent).toContain("MY_SECRET=shh-do-not-tell");
        // Names reach the container uppercased, and empty values are skipped — shared with
        // `functions serve` via `toPlainEdgeRuntimeConfig`.
        expect(envFileContent).toContain("MY_LOWER_SECRET=keep-me");
        expect(envFileContent).not.toContain("my_lower_secret=");
        expect(envFileContent).not.toContain("EMPTY_SECRET=");
      }).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "decrypts an encrypted [edge_runtime.secrets] entry into plaintext, not the raw ciphertext",
      () =>
        withEnvVar(
          "DOTENV_PRIVATE_KEY",
          VAULT_PRIVATE_KEY,
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({
                configContents: `project_id = "demo"\n[edge_runtime.secrets]\nMY_SECRET = "${VAULT_ENCRYPTED}"\n`,
              });

              const fs = yield* FileSystem.FileSystem;
              yield* start(flags()).pipe(Effect.provide(layer));
              const edgeRuntimeRunCall = child.spawned.find((s) => isEdgeRuntimeCreate(s.args));
              const args = edgeRuntimeRunCall?.args ?? [];
              const envFileIndex = args.indexOf("--env-file");
              const envFilePath = envFileIndex !== -1 ? args[envFileIndex + 1] : undefined;
              expect(envFilePath).toBeDefined();
              const envFileContent = yield* fs.readFileString(envFilePath ?? "");
              expect(envFileContent).toContain("MY_SECRET=value");
              expect(envFileContent).not.toContain("encrypted:");
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails with a typed config error, before any container is created, on an undecryptable [edge_runtime.secrets] entry",
      () =>
        withEnvVar(
          "DOTENV_PRIVATE_KEY",
          undefined,
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({
                configContents: `project_id = "demo"\n[edge_runtime.secrets]\nMY_SECRET = "${VAULT_ENCRYPTED}"\n`,
              });

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("DbConfigLoadError");
                expect(serialized).toContain("failed to parse config: missing private key");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_API_* env overrides reach PostgREST and Studio", () => {
    it.live("honors SUPABASE_API_SCHEMAS/_EXTRA_SEARCH_PATH/_MAX_ROWS in both containers", () =>
      withEnvVar(
        "SUPABASE_API_SCHEMAS",
        "public,custom",
        withEnvVar(
          "SUPABASE_API_EXTRA_SEARCH_PATH",
          "extensions,other",
          withEnvVar(
            "SUPABASE_API_MAX_ROWS",
            "500",
            Effect.suspend(() => {
              return Effect.gen(function* () {
                const { layer, child } = yield* setup();

                yield* start(flags()).pipe(Effect.provide(layer));
                const restCreate = child.spawned.find(
                  (s) =>
                    s.args[0] === "create" &&
                    containerNameFromCreateArgs(s.args).includes("_rest_"),
                );
                expect(restCreate?.env["PGRST_DB_SCHEMAS"]).toBe("public,custom");
                expect(restCreate?.env["PGRST_DB_EXTRA_SEARCH_PATH"]).toBe("extensions,other");
                expect(restCreate?.env["PGRST_DB_MAX_ROWS"]).toBe("500");
                const studioCreate = child.spawned.find(
                  (s) =>
                    s.args[0] === "create" &&
                    containerNameFromCreateArgs(s.args).includes("_studio_"),
                );
                expect(studioCreate?.env["PGRST_DB_SCHEMAS"]).toBe("public,custom");
                expect(studioCreate?.env["PGRST_DB_EXTRA_SEARCH_PATH"]).toBe("extensions,other");
                expect(studioCreate?.env["PGRST_DB_MAX_ROWS"]).toBe("500");
              }).pipe(Effect.provide(BunServices.layer));
            }),
          ),
        ),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails with a typed config error, before any container is created, on an invalid SUPABASE_API_MAX_ROWS",
      () =>
        withEnvVar(
          "SUPABASE_API_MAX_ROWS",
          "not-a-number",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                expect(Cause.pretty(exit.cause)).toContain("StartInvalidConfigError");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_DB_POOLER_* env overrides reach Supavisor", () => {
    it.live("SUPABASE_DB_POOLER_POOL_MODE=session flips the published host port to 5432", () =>
      withEnvVar(
        "SUPABASE_DB_POOLER_POOL_MODE",
        "session",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup({
              configContents: 'project_id = "demo"\n[db.pooler]\nenabled = true\n',
            });

            yield* start(flags()).pipe(Effect.provide(layer));
            const poolerCreate = child.spawned.find(
              (s) =>
                s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_pooler_"),
            );
            // `db.pooler.port` defaults to 54329; the exposed-ports list always contains both 5432
            // and 6543, so assert on the specific `hostPort:containerPort` mapping instead.
            expect(poolerCreate?.args).toContain("54329:5432");
            expect(poolerCreate?.args).not.toContain("54329:6543");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails with a typed config error, before any container is created, on an invalid SUPABASE_DB_POOLER_POOL_MODE",
      () =>
        withEnvVar(
          "SUPABASE_DB_POOLER_POOL_MODE",
          "bogus",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({
                configContents: 'project_id = "demo"\n[db.pooler]\nenabled = true\n',
              });

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                expect(Cause.pretty(exit.cause)).toContain("StartInvalidConfigError");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails with a typed config error, before any container is created, on an invalid SUPABASE_REALTIME_ENABLED",
      () =>
        withEnvVar(
          "SUPABASE_REALTIME_ENABLED",
          "maybe",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({ configContents: 'project_id = "demo"\n' });

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                expect(Cause.pretty(exit.cause)).toContain("StartInvalidConfigError");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("SUPABASE_DB_POOLER_PORT overrides the published host port", () =>
      withEnvVar(
        "SUPABASE_DB_POOLER_PORT",
        "60001",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup({
              configContents: 'project_id = "demo"\n[db.pooler]\nenabled = true\n',
            });

            yield* start(flags()).pipe(Effect.provide(layer));
            const poolerCreate = child.spawned.find(
              (s) =>
                s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_pooler_"),
            );
            // Default pool_mode ("transaction") publishes the pooler port against
            // container port 6543 — see the SUPABASE_DB_POOLER_POOL_MODE test above.
            expect(poolerCreate?.args).toContain("60001:6543");
            expect(poolerCreate?.args).not.toContain("54329:6543");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_ANALYTICS_PORT override", () => {
    it.live("overrides the published Logflare host port", () =>
      withEnvVar(
        "SUPABASE_ANALYTICS_PORT",
        "60002",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup();

            yield* start(flags()).pipe(Effect.provide(layer));
            const logflareCreate = child.spawned.find(
              (s) =>
                s.args[0] === "create" &&
                containerNameFromCreateArgs(s.args).includes("_analytics_"),
            );
            expect(logflareCreate?.args).toContain("60002:4000");
            expect(logflareCreate?.args).not.toContain("54327:4000");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "fails with a typed config error, before any container is created, on an invalid SUPABASE_ANALYTICS_VECTOR_PORT",
      () =>
        withEnvVar(
          "SUPABASE_ANALYTICS_VECTOR_PORT",
          "not-a-port",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup();

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                const serialized = Cause.pretty(exit.cause);
                expect(serialized).toContain("StartInvalidConfigError");
                expect(serialized).toContain("invalid config for analytics.vector_port");
              }
              expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_DB_HEALTH_TIMEOUT override", () => {
    it.live(
      "honors an env-overridden health_timeout, not just the config.toml/default value",
      () =>
        withEnvVar(
          "SUPABASE_DB_HEALTH_TIMEOUT",
          "2s",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const neverHealthy = new Set<string>();
              const base = defaultRoute({ neverHealthy });
              const route = (args: ReadonlyArray<string>): RouteResult => {
                if (args[0] === "create") {
                  const name = containerNameFromCreateArgs(args);
                  if (name.includes("_db_")) neverHealthy.add(name);
                }
                return base(args);
              };
              const { layer, child } = yield* setup({ route });

              const exit = yield* Effect.exit(start(flags()).pipe(Effect.provide(layer)));
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) {
                expect(Cause.pretty(exit.cause)).toContain("HealthCheckTimeoutError");
              }
              // Postgres's own health wait fails before any other service is ever created —
              // proving the short env-overridden timeout took effect (the default is much longer).
              expect(createdContainerNames(child.spawned)).toEqual([
                expect.stringContaining("_db_"),
              ]);
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
      10_000,
    );
  });

  describe("auth.hook.* env overrides reach GoTrue's container", () => {
    it.live("honors SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED/_URI", () =>
      withEnvVar(
        "SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED",
        "true",
        withEnvVar(
          "SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI",
          "pg-functions://postgres/auth/custom-access-token-hook",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({
                configContents:
                  'project_id = "demo"\n[auth.hook.custom_access_token]\nenabled = false\n',
              });

              yield* start(flags()).pipe(Effect.provide(layer));
              const gotrueCreate = child.spawned.find(
                (s) =>
                  s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
              );
              expect(gotrueCreate?.env["GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED"]).toBe("true");
              expect(gotrueCreate?.env["GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI"]).toBe(
                "pg-functions://postgres/auth/custom-access-token-hook",
              );
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("auth.captcha.* env overrides reach GoTrue's container", () => {
    it.live("honors SUPABASE_AUTH_CAPTCHA_ENABLED/_PROVIDER", () =>
      withEnvVar(
        "SUPABASE_AUTH_CAPTCHA_ENABLED",
        "true",
        withEnvVar(
          "SUPABASE_AUTH_CAPTCHA_PROVIDER",
          "turnstile",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({
                configContents:
                  'project_id = "demo"\n[auth.captcha]\nenabled = false\nprovider = "hcaptcha"\nsecret = "test-secret"\n',
              });

              yield* start(flags()).pipe(Effect.provide(layer));
              const gotrueCreate = child.spawned.find(
                (s) =>
                  s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
              );
              expect(gotrueCreate?.env["GOTRUE_SECURITY_CAPTCHA_ENABLED"]).toBe("true");
              expect(gotrueCreate?.env["GOTRUE_SECURITY_CAPTCHA_PROVIDER"]).toBe("turnstile");
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("nested auth security env overrides reach GoTrue's container", () => {
    it.live("honors SUPABASE_AUTH_SESSIONS_TIMEBOX", () =>
      withEnvVar(
        "SUPABASE_AUTH_SESSIONS_TIMEBOX",
        "24h",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup({ configContents: 'project_id = "demo"\n' });

            yield* start(flags()).pipe(Effect.provide(layer));
            const gotrueCreate = child.spawned.find(
              (s) =>
                s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
            );
            expect(gotrueCreate?.env["GOTRUE_SESSIONS_TIMEBOX"]).toBe("24h0m0s");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("honors SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED/_VERIFY_ENABLED", () =>
      withEnvVar(
        "SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED",
        "true",
        withEnvVar(
          "SUPABASE_AUTH_MFA_TOTP_VERIFY_ENABLED",
          "true",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({
                configContents: 'project_id = "demo"\n[auth.mfa.totp]\nenroll_enabled = false\n',
              });

              yield* start(flags()).pipe(Effect.provide(layer));
              const gotrueCreate = child.spawned.find(
                (s) =>
                  s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
              );
              expect(gotrueCreate?.env["GOTRUE_MFA_TOTP_ENROLL_ENABLED"]).toBe("true");
              expect(gotrueCreate?.env["GOTRUE_MFA_TOTP_VERIFY_ENABLED"]).toBe("true");
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("honors SUPABASE_AUTH_RATE_LIMIT_SMS_SENT", () =>
      withEnvVar(
        "SUPABASE_AUTH_RATE_LIMIT_SMS_SENT",
        "99",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup({ configContents: 'project_id = "demo"\n' });

            yield* start(flags()).pipe(Effect.provide(layer));
            const gotrueCreate = child.spawned.find(
              (s) =>
                s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
            );
            expect(gotrueCreate?.env["GOTRUE_RATE_LIMIT_SMS_SENT"]).toBe("99");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("honors SUPABASE_AUTH_WEB3_SOLANA_ENABLED", () =>
      withEnvVar(
        "SUPABASE_AUTH_WEB3_SOLANA_ENABLED",
        "true",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup({ configContents: 'project_id = "demo"\n' });

            yield* start(flags()).pipe(Effect.provide(layer));
            const gotrueCreate = child.spawned.find(
              (s) =>
                s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
            );
            expect(gotrueCreate?.env["GOTRUE_EXTERNAL_WEB3_SOLANA_ENABLED"]).toBe("true");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("honors SUPABASE_AUTH_OAUTH_SERVER_ENABLED", () =>
      withEnvVar(
        "SUPABASE_AUTH_OAUTH_SERVER_ENABLED",
        "true",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup({ configContents: 'project_id = "demo"\n' });

            yield* start(flags()).pipe(Effect.provide(layer));
            const gotrueCreate = child.spawned.find(
              (s) =>
                s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
            );
            expect(gotrueCreate?.env["GOTRUE_OAUTH_SERVER_ENABLED"]).toBe("true");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("auth.passkey/auth.webauthn env overrides reach GoTrue's container", () => {
    it.live("honors SUPABASE_AUTH_PASSKEY_ENABLED", () =>
      withEnvVar(
        "SUPABASE_AUTH_PASSKEY_ENABLED",
        "true",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup({
              configContents:
                'project_id = "demo"\n[auth.passkey]\nenabled = false\n[auth.webauthn]\nrp_id = "localhost"\nrp_origins = ["http://localhost:3000"]\n',
            });

            yield* start(flags()).pipe(Effect.provide(layer));
            const gotrueCreate = child.spawned.find(
              (s) =>
                s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
            );
            expect(gotrueCreate?.env["GOTRUE_PASSKEY_ENABLED"]).toBe("true");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live("honors SUPABASE_AUTH_WEBAUTHN_RP_ID/_RP_DISPLAY_NAME/_RP_ORIGINS", () =>
      withEnvVar(
        "SUPABASE_AUTH_WEBAUTHN_RP_ID",
        "env-rp-id",
        withEnvVar(
          "SUPABASE_AUTH_WEBAUTHN_RP_DISPLAY_NAME",
          "Env Display Name",
          withEnvVar(
            "SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS",
            "http://a.example,http://b.example",
            Effect.suspend(() => {
              return Effect.gen(function* () {
                const { layer, child } = yield* setup({
                  configContents:
                    'project_id = "demo"\n[auth.webauthn]\nrp_id = "toml-rp-id"\nrp_display_name = "TOML Display Name"\nrp_origins = ["http://toml.example"]\n',
                });

                yield* start(flags()).pipe(Effect.provide(layer));
                const gotrueCreate = child.spawned.find(
                  (s) =>
                    s.args[0] === "create" &&
                    containerNameFromCreateArgs(s.args).includes("_auth_"),
                );
                expect(gotrueCreate?.env["GOTRUE_WEBAUTHN_RP_ID"]).toBe("env-rp-id");
                expect(gotrueCreate?.env["GOTRUE_WEBAUTHN_RP_DISPLAY_NAME"]).toBe(
                  "Env Display Name",
                );
                expect(gotrueCreate?.env["GOTRUE_WEBAUTHN_RP_ORIGINS"]).toBe(
                  "http://a.example,http://b.example",
                );
              }).pipe(Effect.provide(BunServices.layer));
            }),
          ),
        ),
      ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "coerces an env(...)-resolved passkey enabled string instead of reading it as disabled",
      () =>
        withEnvVar(
          "PASSKEY_ENABLED",
          "true",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({
                configContents:
                  'project_id = "demo"\n[auth.passkey]\nenabled = "env(PASSKEY_ENABLED)"\n[auth.webauthn]\nrp_id = "localhost"\nrp_origins = ["http://localhost:3000"]\n',
              });

              yield* start(flags()).pipe(Effect.provide(layer));
              const gotrueCreate = child.spawned.find(
                (s) =>
                  s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
              );
              expect(gotrueCreate?.env["GOTRUE_PASSKEY_ENABLED"]).toBe("true");
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );

    it.live(
      "splits an env(...)-resolved comma-separated rp_origins string instead of dropping it to []",
      () =>
        withEnvVar(
          "RP_ORIGINS",
          "http://a.example,http://b.example",
          Effect.suspend(() => {
            return Effect.gen(function* () {
              const { layer, child } = yield* setup({
                configContents:
                  'project_id = "demo"\n[auth.passkey]\nenabled = true\n[auth.webauthn]\nrp_id = "localhost"\nrp_origins = "env(RP_ORIGINS)"\n',
              });

              yield* start(flags()).pipe(Effect.provide(layer));
              const gotrueCreate = child.spawned.find(
                (s) =>
                  s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
              );
              expect(gotrueCreate?.env["GOTRUE_WEBAUTHN_RP_ORIGINS"]).toBe(
                "http://a.example,http://b.example",
              );
            }).pipe(Effect.provide(BunServices.layer));
          }),
        ).pipe(Effect.provide(BunServices.layer)),
    );
  });

  describe("SUPABASE_EDGE_RUNTIME_POLICY override", () => {
    it.live("honors the env-overridden Edge Runtime request policy", () =>
      withEnvVar(
        "SUPABASE_EDGE_RUNTIME_POLICY",
        "per_worker",
        Effect.suspend(() => {
          return Effect.gen(function* () {
            const { layer, child } = yield* setup({
              configContents: 'project_id = "demo"\n[edge_runtime]\npolicy = "oneshot"\n',
            });

            yield* start(flags()).pipe(Effect.provide(layer));
            const runCalls = child.spawned.filter((s) => isEdgeRuntimeCreate(s.args));
            const entrypointCommand = runCalls[0]?.args.at(-1) ?? "";
            expect(entrypointCommand).toContain("--policy=per_worker");
            expect(entrypointCommand).not.toContain("--policy=oneshot");
          }).pipe(Effect.provide(BunServices.layer));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    );
  });
});
