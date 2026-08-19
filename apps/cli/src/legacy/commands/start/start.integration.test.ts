import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Option, PlatformError, Sink, Stream } from "effect";
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
} from "../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
  useLegacyShadowCacheDisabled,
  useLegacyTempWorkdir,
  legacySequentialExecBatch,
} from "../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { classifyCliCauseActionability } from "../../../shared/telemetry/error-actionability.ts";
import {
  LegacyDebugFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyYesFlag,
} from "../../../shared/legacy/global-flags.ts";
import { LegacyPlatformApiFactory } from "../../auth/legacy-platform-api-factory.service.ts";
import {
  legacyServiceContainerIds,
  legacyServiceContainerName,
} from "../../shared/legacy-docker-ids.ts";
import {
  LegacyDbConnection,
  type LegacyDbSession,
} from "../../shared/legacy-db-connection.service.ts";
import { legacyDockerRunLayer } from "../../shared/legacy-docker-run.layer.ts";
import { LegacyEdgeRuntimeScriptError } from "../../shared/legacy-edge-runtime-script.errors.ts";
import {
  LegacyEdgeRuntimeScript,
  type LegacyEdgeRuntimeRunOpts,
} from "../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { LEGACY_START_EXCLUDABLE_KEYS } from "./start.exclude.ts";
import type { LegacyStartFlags } from "./start.command.ts";
import { legacyStart } from "./start.handler.ts";
import {
  LEGACY_KONG_LOCAL_TLS_CERT,
  LEGACY_KONG_LOCAL_TLS_KEY,
} from "./templates/kong-local-tls.ts";

/**
 * Counts real invocations of `legacyResolveLocalConfigValues` across this
 * whole file — every test transparently delegates to the real
 * implementation, so this is purely an observation point. It exists for the
 * "resolved once, reused everywhere" regression test below (CLI-1323's
 * status-print/bring-up JWT divergence): `start`'s success-path status print
 * must reuse the SAME resolved `values` bring-up already used to build every
 * container spec, not call this a second time — a second call re-signs
 * `auth.signing_keys_path` JWTs with a different `exp` claim
 * ({@link legacyGenerateAsymmetricGoJwt}), producing a byte-different
 * anon/service-role key than the one already baked into the running
 * containers.
 */
const legacyResolveLocalConfigValuesCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../shared/legacy-local-config-values.ts", async () => {
  const actual = await vi.importActual<typeof import("../../shared/legacy-local-config-values.ts")>(
    "../../shared/legacy-local-config-values.ts",
  );
  return {
    ...actual,
    legacyResolveLocalConfigValues: (
      ...args: Parameters<typeof actual.legacyResolveLocalConfigValues>
    ) => {
      legacyResolveLocalConfigValuesCalls.count++;
      return actual.legacyResolveLocalConfigValues(...args);
    },
  };
});

const tempRoot = useLegacyTempWorkdir("supabase-start-int-");

// The baseline cache (`db-bootstrap/main-db-baseline.ts`) is ON by default and reads
// `process.env` directly, so every fresh-volume bring-up below would otherwise restore or publish
// a real tar under the developer's own `~/.supabase`. This suite's subject is the bring-up itself;
// the cache-focused scenarios opt back in per-test with `withLegacyShadowCacheEnabled`.
useLegacyShadowCacheDisabled();

function flags(overrides: Partial<LegacyStartFlags> = {}): LegacyStartFlags {
  return {
    exclude: overrides.exclude ?? [],
    ignoreHealthCheck: overrides.ignoreHealthCheck ?? false,
    preview: overrides.preview ?? false,
  };
}

function writeConfig(workdir: string, contents: string) {
  const supabaseDir = join(workdir, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
  writeFileSync(join(supabaseDir, "config.toml"), contents);
}

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
  route: (args: ReadonlyArray<string>) => RouteResult,
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
          return yield* Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "spawn failed",
            }),
          );
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

        const result = route(args);
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

/** Edge Runtime's own create/cp/start bring-up sits outside `legacyCreateContainer`; its create is recognized by the `_edge_runtime_` container name. */
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
  // `legacyCreateContainer` brought up", the premise of the exact-equality assertions below.
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
  base: (args: ReadonlyArray<string>) => RouteResult,
): (args: ReadonlyArray<string>) => RouteResult {
  return (args) => {
    // `legacyVolumeExists` distinguishes a confirmed "not found" from any
    // other inspect error — the stderr text is what makes this simulate a
    // genuinely fresh/non-existent volume rather than an ambiguous inspect
    // failure.
    if (args[0] === "volume" && args[1] === "inspect") {
      return { exitCode: 1, stderr: [`Error: No such volume: ${args[2] ?? ""}`] };
    }
    return base(args);
  };
}

/** Storage's `/storage/v1/bucket` GET (list)/POST (create) endpoints — every other request answers a bare 200, matching `alwaysReadyHttpClientLayer`'s permissiveness for the PostgREST/Edge Runtime readiness probes some scenarios also exercise. */
function mockStorageBucketHttpClient() {
  const createdBucketRequests: Array<string> = [];
  const createdBucketBodies: Array<unknown> = [];
  const layer = Layer.succeed(
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
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
      );
    }),
  );
  return { layer, createdBucketRequests, createdBucketBodies };
}

/**
 * A fake `LegacyDbSession` recording every `exec`/`query` call — the fresh-volume
 * `SetupLocalDatabase`-equivalent path (`legacyRunFreshDbSetup`) needs an
 * open session for PG<=14's schema SQL / `ApplyApiPrivileges`; PG15+ (this suite's
 * default) never calls `exec`/`query` at all (its schema init is three one-shot
 * `LegacyDockerRun` jobs instead — see `db-setup.ts`'s header), so this mostly just
 * needs to exist and satisfy the type. Mirrors `db-setup.unit.test.ts`'s own
 * `fakeSession()`.
 */
function fakeDbSession() {
  const calls: Array<{ kind: "exec" | "query"; sql: string }> = [];
  const session: LegacyDbSession = {
    exec: (sql) =>
      Effect.sync(() => {
        calls.push({ kind: "exec", sql });
      }),
    query: (sql) =>
      Effect.sync(() => {
        calls.push({ kind: "query", sql });
        return [];
      }),
    execBatch: (statements) => legacySequentialExecBatch(session)(statements),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, calls };
}

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly route?: (args: ReadonlyArray<string>) => RouteResult;
  /** Observes files decoded from the in-memory tar stream passed to `docker cp -`. */
  readonly onSecretCopy?: (containerPath: string, content: string) => void;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly configuredProjectId?: string;
  /** Raw `config.toml` contents — overrides `configuredProjectId`'s single-line default. */
  readonly configContents?: string;
  /** Skip writing `config.toml` entirely — the test writes its own (e.g. a malformed file). */
  readonly skipConfig?: boolean;
  /** Every spawn attempt (docker AND its podman fallback) fails outright — neither runtime found. */
  readonly failSpawn?: boolean;
  /** Defaults to `tempRoot.current` — override for `--workdir`-resolution failure tests. */
  readonly workdir?: string;
  /** `--network-id` override. Defaults to unset (the generated `supabase_network_<project>` name applies). */
  readonly networkId?: Option.Option<string>;
  /** `--experimental`/`SUPABASE_EXPERIMENTAL`. Defaults to `false`. */
  readonly experimental?: boolean;
  /** `LegacyEdgeRuntimeScript`'s mocked stdout for the pg-delta catalog-export call (`db-setup.ts`'s `legacyTryCacheMigrationsCatalog`). Only ever reached on a fresh volume with pg-delta enabled. */
  readonly catalogStdout?: string;
  /** Fails the mocked catalog-export call with this message instead of succeeding. */
  readonly catalogExportFailWith?: string;
}

function setup(opts: SetupOpts = {}) {
  const workdir = opts.workdir ?? tempRoot.current;
  if (opts.skipConfig !== true) {
    writeConfig(
      workdir,
      opts.configContents ?? `project_id = "${opts.configuredProjectId ?? "demo"}"\n`,
    );
  }
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockLegacyTelemetryStateTracked();
  const analytics = mockAnalytics();
  const cliConfig = mockLegacyCliConfig({ workdir });
  const child = mockStartContainerCliSpawner(opts.route ?? defaultRoute(), {
    failSpawn: opts.failSpawn,
    onSecretCopy: opts.onSecretCopy,
  });
  const dbSession = fakeDbSession();
  const edgeRunCalls: Array<LegacyEdgeRuntimeRunOpts> = [];
  const edgeRuntime = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (runOpts: LegacyEdgeRuntimeRunOpts) => {
      edgeRunCalls.push(runOpts);
      if (opts.catalogExportFailWith !== undefined) {
        return Effect.fail(
          new LegacyEdgeRuntimeScriptError({ message: opts.catalogExportFailWith }),
        );
      }
      return Effect.succeed({ stdout: opts.catalogStdout ?? '{"version":1}', stderr: "" });
    },
  });
  const sslProbe = Layer.succeed(LegacyPgDeltaSslProbe, {
    requireSsl: () => Effect.succeed(false),
    requireSslForHost: () => Effect.succeed(false),
  });

  const layer = Layer.mergeAll(
    BunServices.layer,
    out.layer,
    cliConfig,
    telemetry.layer,
    analytics.layer,
    child.layer,
    opts.httpClientLayer ?? alwaysReadyHttpClientLayer,
    // Only ever exercised by a fresh-volume scenario (`volume inspect` exiting
    // non-zero) — every other scenario's default "volume already exists" route
    // never reaches `legacyRunFreshDbSetup`/`legacySeedBucketsRun`, but
    // both are still part of `legacyStart`'s aggregate Effect type, so every
    // scenario needs these satisfied regardless of whether it exercises them.
    Layer.succeed(LegacyDbConnection, { connect: () => Effect.succeed(dbSession.session) }),
    // `Layer.mergeAll` never cross-wires sibling requirements (see
    // `apps/cli/CLAUDE.md`'s "Layer.provide does not share to siblings"
    // note) — `legacyDockerRunLayer` needs `ChildProcessSpawner`/
    // `ProcessControl` provided to IT explicitly, not just present elsewhere
    // in this same merge.
    legacyDockerRunLayer.pipe(
      Layer.provide(child.layer),
      Layer.provide(mockProcessControl().layer),
    ),
    mockProcessControl().layer,
    mockRuntimeInfo({ platform: "linux" }),
    Layer.succeed(LegacyPlatformApiFactory, {
      make: Effect.die("LegacyPlatformApiFactory should not be used by a local start"),
    }),
    Layer.succeed(CliArgs, { args: ["start"] }),
    Layer.succeed(LegacyDebugFlag, false),
    Layer.succeed(LegacyYesFlag, false),
    Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? false),
    Layer.succeed(LegacyNetworkIdFlag, opts.networkId ?? Option.none()),
    mockTty({ stdinIsTty: false }),
    mockStdin(false),
    edgeRuntime,
    sslProbe,
  );

  return { workdir, out, telemetry, analytics, child, dbSession, edgeRunCalls, layer };
}

/**
 * Maps each of the 13 valid `--exclude` keys (`start.exclude.ts`) to the
 * container-name suffix(es) that key skips, for the parameterized exclusion
 * matrix test below. `storage-api` is compound: excluding it also disables
 * ImgProxy (`start.gates.ts`'s `imgproxy: storage && ...` dependency).
 * `edge-runtime` maps to no suffix at all here — it DOES really start now
 * (`legacyStartEdgeRuntimeContainer`, its own create/cp/start bring-up outside
 * `legacyCreateContainer`, which `createdContainerNames` excludes), so
 * `--exclude edge-runtime` is exercised by its own
 * dedicated scenarios below rather than through this `docker create`-based
 * matrix.
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

// A known test vector: this ciphertext decrypts to "value" under the keypair
// below — same fixture used by `legacy-local-config-values.unit.test.ts`'s
// "encrypted auth secrets" suite. Hoisted to file scope so both the GoTrue-secret suite and the
// Edge-Runtime-secret suite below reuse the exact same known-good dotenvx ciphertext instead of
// each needing to produce their own (that requires the real ECIES encryption this fixture already
// captures).
const VAULT_PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
const VAULT_ENCRYPTED =
  "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";

describe("legacy start integration", () => {
  describe("--exclude validation", () => {
    it.live("warns on stderr for an invalid --exclude value, even when already running", () => {
      const { layer, out } = setup({
        route: (args) => {
          if (args[0] === "container" && args[1] === "inspect") {
            return { stdout: [HEALTHY_STATE] };
          }
          if (args[0] === "ps") return { stdout: [] };
          return { exitCode: 0 };
        },
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags({ exclude: ["not-a-real-service"] }));
        expect(out.stderrText).toContain("WARNING:");
        expect(out.stderrText).toContain("not-a-real-service");
        expect(out.stderrText).toContain("not valid to exclude");
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "rejects --exclude db and --exclude postgres as invalid, since Postgres has no exclude key",
      () => {
        const { layer, out, child } = setup();
        return Effect.gen(function* () {
          yield* legacyStart(flags({ exclude: ["db", "postgres"] }));
          expect(out.stderrText).toContain("WARNING:");
          expect(out.stderrText).toContain("db, postgres");
          expect(out.stderrText).toContain("not valid to exclude");
          // An invalid --exclude value must never silently skip Postgres itself.
          expect(createdContainerNames(child.spawned).some((name) => name.includes("_db_"))).toBe(
            true,
          );
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("already running", () => {
    it.live(
      "prints the already-running banner and renders status without creating any containers",
      () => {
        const { layer, out, child } = setup({
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              return { stdout: [HEALTHY_STATE] };
            }
            if (args[0] === "ps") return { stdout: [] };
            return { exitCode: 0 };
          },
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          expect(out.stderrText).toContain("supabase start");
          expect(out.stderrText).toContain("is already running");
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("reports the stack is already running with a machine payload in json mode", () => {
      const { layer, out } = setup({
        format: "json",
        route: (args) => {
          if (args[0] === "container" && args[1] === "inspect") {
            return { stdout: [HEALTHY_STATE] };
          }
          if (args[0] === "ps") return { stdout: [] };
          return { exitCode: 0 };
        },
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.data).toMatchObject({ DB_URL: expect.any(String) });
        expect(out.stderrText).not.toContain("is already running");
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "reports the stack is already running with a machine payload in stream-json mode",
      () => {
        const { layer, out } = setup({
          format: "stream-json",
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              return { stdout: [HEALTHY_STATE] };
            }
            if (args[0] === "ps") return { stdout: [] };
            return { exitCode: 0 };
          },
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const success = out.messages.find((m) => m.type === "success");
          expect(success?.data).toMatchObject({ DB_URL: expect.any(String) });
          expect(out.stderrText).not.toContain("is already running");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails when the already-running DB container stops running before the health re-check",
      () => {
        let inspectCalls = 0;
        const { layer, child } = setup({
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              inspectCalls += 1;
              if (inspectCalls === 1) return { stdout: [HEALTHY_STATE] };
              return { stdout: [JSON.stringify({ Status: "exited", Running: false })] };
            }
            return { exitCode: 0 };
          },
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyStatusDbNotRunningError");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails when the already-running DB container is unhealthy on the health re-check",
      () => {
        let inspectCalls = 0;
        const { layer } = setup({
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              inspectCalls += 1;
              if (inspectCalls === 1) return { stdout: [HEALTHY_STATE] };
              return { stdout: [STARTING_STATE] };
            }
            return { exitCode: 0 };
          },
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyStatusDbNotReadyError");
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails when the already-running DB container's health re-check inspect itself errors",
      () => {
        let inspectCalls = 0;
        const { layer } = setup({
          route: (args) => {
            if (args[0] === "container" && args[1] === "inspect") {
              inspectCalls += 1;
              if (inspectCalls === 1) return { stdout: [HEALTHY_STATE] };
              return { exitCode: 1, stderr: ["permission denied"] };
            }
            return { exitCode: 0 };
          },
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStatusDbInspectError");
            expect(serialized).toContain("permission denied");
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("fails when listing running containers errors while already running", () => {
      const { layer } = setup({
        route: (args) => {
          if (args[0] === "container" && args[1] === "inspect") {
            return { stdout: [HEALTHY_STATE] };
          }
          if (args[0] === "ps") return { exitCode: 1, stderr: ["daemon down"] };
          return { exitCode: 0 };
        },
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacyStatusListError");
        }
      }).pipe(Effect.provide(layer));
    });

    it.live("already running, --ignore-health-check skips the health re-check entirely", () => {
      let inspectCalls = 0;
      const { layer, child } = setup({
        route: (args) => {
          if (args[0] === "container" && args[1] === "inspect") {
            inspectCalls += 1;
            // Only the FIRST inspect (`AssertSupabaseDbIsRunning`) should ever fire — a second
            // call here would mean the health re-check ran despite the flag.
            if (inspectCalls === 1) return { stdout: [HEALTHY_STATE] };
            return { exitCode: 1, stderr: ["should not be called"] };
          }
          if (args[0] === "ps") return { stdout: [] };
          return { exitCode: 0 };
        },
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags({ ignoreHealthCheck: true }));
        expect(inspectCalls).toBe(1);
        expect(child.spawned.some((s) => s.args[0] === "ps")).toBe(true);
      }).pipe(Effect.provide(layer));
    });

    it.live("already running with every service still up omits the 'Stopped services' line", () => {
      const { layer, out } = setup({
        route: (args) => {
          if (args[0] === "container" && args[1] === "inspect") {
            return { stdout: [HEALTHY_STATE] };
          }
          if (args[0] === "ps") return { stdout: [...legacyServiceContainerIds("demo")] };
          return { exitCode: 0 };
        },
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        expect(out.stderrText).not.toContain("Stopped services");
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "fails on a bucket's invalid file_size_limit even when already running, matching Go's Config.Load",
      () => {
        // `legacyCheckDbToml` runs unconditionally at the very top of this handler, before
        // `dbContainerId`/the already-running short-circuit are even computed — unlike the later
        // wrapConfigOverride checks (e.g. storage.analytics.enabled), which sit AFTER the
        // already-running early return and therefore never run in this branch. A malformed
        // per-bucket file_size_limit must still fail here, before the already-running banner ever
        // prints — config decrypting/decoding happens unconditionally regardless of
        // whether the stack is already up.
        const { layer, child } = setup({
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
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyDbConfigLoadError");
            expect(serialized).toContain(
              "failed to parse config: invalid storage.buckets.avatars.file_size_limit.",
            );
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("stopped project recovery", () => {
    it.live("recreates stopped project containers without pruning the database volume", () => {
      const workdir = tempRoot.current;
      const route = defaultRoute();
      let recovering = false;
      const { layer, out, child } = setup({
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

      return Effect.gen(function* () {
        yield* legacyStart(flags());

        expect(out.stderrText).not.toContain("is already running");
        expect(createdContainerNames(child.spawned)).toContain("supabase_db_demo");
        expect(
          child.spawned
            .filter((spawn) => spawn.args[0] === "stop")
            .map((spawn) => spawn.args[1])
            .sort(),
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
      }).pipe(Effect.provide(layer));
    });

    it.live("does not remove containers when the project id sanitizes to empty", () => {
      const { layer, child } = setup({
        configContents: 'project_id = "!!!"\n',
        route: (args) => {
          if (args[0] === "container" && args[1] === "inspect" && args[2] === "supabase_db_") {
            return { stdout: [STOPPED_STATE] };
          }
          return { exitCode: 0 };
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacyStartInvalidConfigError");
        }
        expect(
          child.spawned.some(
            (spawn) =>
              (spawn.args[0] === "ps" && spawn.args.includes("--all")) || spawn.args[1] === "prune",
          ),
        ).toBe(false);
      }).pipe(Effect.provide(layer));
    });

    it.live("preserves a stopped Bitbucket database container", () => {
      const previous = process.env["BITBUCKET_CLONE_DIR"];
      process.env["BITBUCKET_CLONE_DIR"] = "/opt/atlassian/pipelines/agent/build";
      const { layer, child } = setup({
        route: (args) => {
          if (args[0] === "container" && args[1] === "inspect") {
            return { stdout: [STOPPED_STATE] };
          }
          return { exitCode: 0 };
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacyStatusDbNotRunningError");
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
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["BITBUCKET_CLONE_DIR"];
            else process.env["BITBUCKET_CLONE_DIR"] = previous;
          }),
        ),
      );
    });

    it.live("does not remove containers when re-inspect returns an unknown state", () => {
      let dbInspects = 0;
      const { layer, child } = setup({
        route: (args) => {
          if (args[0] === "container" && args[1] === "inspect") {
            dbInspects += 1;
            return { stdout: [dbInspects === 1 ? STOPPED_STATE : ""] };
          }
          return { exitCode: 0 };
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(
          child.spawned.some(
            (spawn) =>
              (spawn.args[0] === "ps" && spawn.args.includes("--all")) || spawn.args[1] === "prune",
          ),
        ).toBe(false);
      }).pipe(Effect.provide(layer));
    });

    it.live("does not recover a created database container with unknown volume state", () => {
      const { layer, child } = setup({
        route: (args) => {
          if (args[0] === "container" && args[1] === "inspect") {
            return { stdout: [CREATED_STATE] };
          }
          return { exitCode: 0 };
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = JSON.stringify(exit.cause);
          expect(serialized).toContain("LegacyStatusDbNotRunningError");
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
      }).pipe(Effect.provide(layer));
    });

    it.live("validates custom TLS files before removing a stopped stack", () => {
      const workdir = tempRoot.current;
      const certPath = join(workdir, "supabase", "certs", "server.crt");
      const keyPath = join(workdir, "supabase", "certs", "server.key");
      mkdirSync(join(workdir, "supabase", "certs"), { recursive: true });
      writeFileSync(certPath, "-----BEGIN CERTIFICATE-----");
      writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----");

      const { layer, child } = setup({
        configContents:
          'project_id = "demo"\n[api.tls]\nenabled = true\ncert_path = "certs/server.crt"\nkey_path = "certs/server.key"\n',
        route: (args) => {
          if (args[0] === "container" && args[1] === "inspect") {
            if (existsSync(certPath)) rmSync(certPath);
            return { stdout: [STOPPED_STATE] };
          }
          return { exitCode: 0 };
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = JSON.stringify(exit.cause);
          expect(serialized).toContain("LegacyStartInvalidConfigError");
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
      }).pipe(Effect.provide(layer));
    });

    it.live("validates function bind mounts before removing a stopped stack", () => {
      const workdir = tempRoot.current;
      const entrypointPath = join(workdir, "supabase", "functions", "foo", "index.ts");
      mkdirSync(join(workdir, "supabase", "functions", "foo"), { recursive: true });
      writeFileSync(entrypointPath, "export {};\n");

      const { layer, child } = setup({
        configContents:
          'project_id = "demo"\n[functions.foo]\nentrypoint = "./functions/foo/index.ts"\n',
        route: (args) => {
          if (args[0] === "container" && args[1] === "inspect") {
            if (existsSync(entrypointPath)) rmSync(entrypointPath);
            return { stdout: [STOPPED_STATE] };
          }
          return { exitCode: 0 };
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
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
      }).pipe(Effect.provide(layer));
    });

    it.live("removes remaining project containers when the stopped database disappears", () => {
      const workdir = tempRoot.current;
      const route = defaultRoute();
      let dbInspects = 0;
      const { layer, child } = setup({
        route: (args) => {
          if (args[0] === "container" && args[1] === "inspect" && args[2] === "supabase_db_demo") {
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

      return Effect.gen(function* () {
        yield* legacyStart(flags());

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
      }).pipe(Effect.provide(layer));
    });

    it.live("cleans only current-workdir secrets when recovery fails", () => {
      const workdir = tempRoot.current;
      const staleSecretDir = join(
        workdir,
        "supabase",
        ".temp",
        "start-secrets",
        "supabase_db_demo",
      );
      const staleSecret = join(staleSecretDir, "stale-secret");
      mkdirSync(staleSecretDir, { recursive: true });
      writeFileSync(staleSecret, "stale");
      const foreignWorkdir = join(workdir, "foreign");
      const foreignSecretDir = join(
        foreignWorkdir,
        "supabase",
        ".temp",
        "start-secrets",
        "supabase_kong_demo",
      );
      const foreignSecret = join(foreignSecretDir, "stale-secret");
      mkdirSync(foreignSecretDir, { recursive: true });
      writeFileSync(foreignSecret, "foreign");

      const { layer, child } = setup({
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

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacyDockerRemoveAllNetworkPruneError");
        }
        expect(existsSync(staleSecret)).toBe(false);
        expect(existsSync(foreignSecret)).toBe(true);
        expect(createdContainerNames(child.spawned)).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

    it.live("keeps a stopped stack intact when a later config field fails to parse", () => {
      const { layer, child } = setup({
        configContents: 'project_id = "demo"\n[db]\nhealth_timeout = "not-a-duration"\n',
        route: (args) => {
          if (args[0] === "container" && args[1] === "inspect") {
            return { stdout: [STOPPED_STATE] };
          }
          return { exitCode: 0 };
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacyStartInvalidConfigError");
        }
        expect(
          child.spawned.some(
            (spawn) =>
              (spawn.args[0] === "ps" && spawn.args.includes("--all")) || spawn.args[1] === "prune",
          ),
        ).toBe(false);
        expect(child.spawned.some((spawn) => spawn.args[0] === "stop")).toBe(false);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "reports status instead of tearing down when the stack recovers before teardown",
      () => {
        let dbInspects = 0;
        const { layer, out, child } = setup({
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

        return Effect.gen(function* () {
          yield* legacyStart(flags());

          expect(out.stderrText).toContain("is already running");
          expect(
            child.spawned.some(
              (spawn) =>
                (spawn.args[0] === "ps" && spawn.args.includes("--all")) ||
                spawn.args[1] === "prune",
            ),
          ).toBe(false);
          expect(child.spawned.some((spawn) => spawn.args[0] === "stop")).toBe(false);
          expect(createdContainerNames(child.spawned)).toEqual([]);
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("config load / validation failures", () => {
    it.live("fails when --workdir/SUPABASE_WORKDIR points at a missing path", () => {
      // The explicit workdir is `chdir`'d into before config load or any Docker call — a
      // missing path must fail immediately, matching `status`/`stop`'s own equivalent test.
      const missingWorkdir = join(tempRoot.current, "does-not-exist");
      const { layer, child } = setup({ workdir: missingWorkdir, skipConfig: true });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = JSON.stringify(exit.cause);
          expect(serialized).toContain("LegacyStartWorkdirError");
          expect(serialized).toContain(
            `failed to change workdir: chdir ${missingWorkdir}: no such file or directory`,
          );
        }
        expect(child.spawned).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

    it.live("fails when the DB container inspect fails for a reason other than not-found", () => {
      const { layer, child } = setup({
        route: (args) => {
          if (args[0] === "container" && args[1] === "inspect") {
            return { exitCode: 1, stderr: ["Error response from daemon: permission denied"] };
          }
          return { exitCode: 0 };
        },
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = JSON.stringify(exit.cause);
          expect(serialized).toContain("LegacyDockerLifecycleInspectError");
          expect(serialized).toContain("permission denied");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "fails with a docker-unavailable error when neither docker nor podman can be spawned",
      () => {
        const { layer } = setup({ failSpawn: true });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyDockerLifecycleInspectError");
            expect(serialized).toContain("docker: command not found (podman also not found)");
            expect(classifyCliCauseActionability(exit.cause)).toMatchObject({
              error_kind: "user_actionable",
              error_category: "docker_not_running",
              error_fingerprint: "tag:LegacyDockerLifecycleInspectError:docker_not_running",
            });
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("fails on a malformed config.toml", () => {
      const workdir = tempRoot.current;
      mkdirSync(join(workdir, "supabase"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "config.toml"), "not valid toml =====");
      const { layer, child } = setup({ skipConfig: true });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacyStartConfigLoadError");
        }
        expect(child.spawned).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

    it.live("fails when auth.jwt_secret is configured but shorter than 16 characters", () => {
      const { layer, child } = setup({
        configContents: 'project_id = "demo"\n[auth]\njwt_secret = "too-short"\n',
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = JSON.stringify(exit.cause);
          expect(serialized).toContain("LegacyStartInvalidConfigError");
          expect(serialized).toContain(
            "Invalid config for auth.jwt_secret. Must be at least 16 characters",
          );
        }
        expect(child.spawned).toEqual([]);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("happy path", () => {
    it.live(
      "brings up the full default stack (clean host, every container immediately healthy)",
      () => {
        const { layer, out, child, analytics } = setup();
        return Effect.gen(function* () {
          yield* legacyStart(flags());

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
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("emits a machine status payload in json mode instead of the pretty table", () => {
      const { layer, out } = setup({ format: "json" });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.data).toMatchObject({ DB_URL: expect.any(String) });
        expect(out.stderrText).not.toContain("Started");
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "emits a machine status payload in stream-json mode instead of the pretty table",
      () => {
        const { layer, out } = setup({ format: "stream-json" });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const success = out.messages.find((m) => m.type === "success");
          expect(success?.data).toMatchObject({ DB_URL: expect.any(String) });
          expect(out.stderrText).not.toContain("Started");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("fires cli_stack_started exactly once on a successful start", () => {
      const { layer, analytics } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const stackStartedEvents = analytics.captured.filter(
          (c) => c.event === "cli_stack_started",
        );
        expect(stackStartedEvents).toEqual([{ event: "cli_stack_started", properties: {} }]);
      }).pipe(Effect.provide(layer));
    });

    it.live("brings the stack up when podman rejects re-creating preserved volumes (#6020)", () => {
      const route = defaultRoute();
      const { layer, analytics } = setup({
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
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        expect(analytics.captured.some((c) => c.event === "cli_stack_started")).toBe(true);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "reuses the bring-up-resolved local config values for the final status print instead of re-deriving them",
      () => {
        // Regression test for the CLI-1323 status-print/bring-up divergence:
        // `legacyResolveLocalConfigValues` embeds a fresh `exp` claim
        // (`Date.now()`-derived) into the anon/service-role key every time it
        // asymmetrically signs them via `auth.signing_keys_path`
        // (`legacyGenerateAsymmetricGoJwt`, `legacy-go-jwt.ts:212`). A second,
        // independent resolution for the final status print — rather than
        // reusing the SAME `values` already used to build every container
        // spec — would mint a byte-different key than the one baked into the
        // already-running containers. Asserting a single resolution call is
        // both the most direct way to pin this invariant and immune to the
        // test itself racing real wall-clock time (unlike comparing two
        // independently-generated JWTs, which could coincidentally still
        // match if both calls land within the same clock second).
        const { layer, workdir } = setup({
          format: "json",
          configContents: 'project_id = "demo"\n[auth]\nsigning_keys_path = "signing_keys.json"\n',
        });
        const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const jwk = { ...privateKey.export({ format: "jwk" }), alg: "RS256", kid: "test-kid" };
        writeFileSync(join(workdir, "supabase", "signing_keys.json"), JSON.stringify([jwk]));
        legacyResolveLocalConfigValuesCalls.count = 0;

        return Effect.gen(function* () {
          yield* legacyStart(flags());
          expect(legacyResolveLocalConfigValuesCalls.count).toBe(1);
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("config-driven container-spec branches", () => {
    it.live(
      "fails when a configured third-party auth issuer's JWKS endpoint is unreachable",
      () => {
        // `legacyResolveLocalJwks` (step 6, unconditional) fetches the third-party issuer's own
        // JWKS document via a raw `fetch` — a real network boundary, not the `HttpClient` service
        // this suite otherwise mocks, so it needs its own `globalThis.fetch` stub. A valid
        // firebase config passes config load/validation cleanly (step 2 never performs this
        // fetch), so this is the only way this specific failure surfaces.
        const previousFetch = globalThis.fetch;
        globalThis.fetch = Object.assign(() => Promise.reject(new Error("ECONNREFUSED")), {
          preconnect: previousFetch.preconnect,
        });
        const { layer, child } = setup({
          configContents:
            'project_id = "demo"\n[auth.third_party.firebase]\nenabled = true\nproject_id = "fb-project"\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyStartInvalidConfigError");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              globalThis.fetch = previousFetch;
            }),
          ),
        );
      },
    );

    it.live("reads and mounts a configured API TLS cert/key pair for Kong", () => {
      const { layer, workdir, child } = setup({
        configContents:
          'project_id = "demo"\n[api.tls]\nenabled = true\ncert_path = "certs/server.crt"\nkey_path = "certs/server.key"\n',
      });
      mkdirSync(join(workdir, "supabase", "certs"), { recursive: true });
      writeFileSync(
        join(workdir, "supabase", "certs", "server.crt"),
        "-----BEGIN CERTIFICATE-----",
      );
      writeFileSync(
        join(workdir, "supabase", "certs", "server.key"),
        "-----BEGIN PRIVATE KEY-----",
      );
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        expect(createdContainerNames(child.spawned).some((name) => name.includes("_kong_"))).toBe(
          true,
        );
      }).pipe(Effect.provide(layer));
    });

    it.live("fails when a configured API TLS cert file cannot be read", () => {
      const { layer, workdir, child } = setup({
        configContents:
          'project_id = "demo"\n[api.tls]\nenabled = true\ncert_path = "certs/server.crt"\nkey_path = "certs/server.key"\n',
      });
      mkdirSync(join(workdir, "supabase", "certs"), { recursive: true });
      writeFileSync(
        join(workdir, "supabase", "certs", "server.key"),
        "-----BEGIN PRIVATE KEY-----",
      );
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = JSON.stringify(exit.cause);
          expect(serialized).toContain("LegacyStartInvalidConfigError");
          expect(serialized).toContain("failed to read TLS cert");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      }).pipe(Effect.provide(layer));
    });

    it.live("fails when a configured API TLS key file cannot be read", () => {
      const { layer, workdir, child } = setup({
        configContents:
          'project_id = "demo"\n[api.tls]\nenabled = true\ncert_path = "certs/server.crt"\nkey_path = "certs/server.key"\n',
      });
      mkdirSync(join(workdir, "supabase", "certs"), { recursive: true });
      writeFileSync(
        join(workdir, "supabase", "certs", "server.crt"),
        "-----BEGIN CERTIFICATE-----",
      );
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = JSON.stringify(exit.cause);
          expect(serialized).toContain("LegacyStartInvalidConfigError");
          expect(serialized).toContain("failed to read TLS key");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "brings up the stack with every optional config.toml section populated (bigquery analytics, session pool mode, passkey/webauthn, external provider, SMTP, email templates)",
      () => {
        // Exercises the config-document-shape branches `start.handler.ts` itself owns
        // (`legacyResolveGotruePasskeyWebauthn`, `resolveGotrueExternalProviders`,
        // `buildKongEmailTemplateMounts`, `values.analyticsBackend`) in one pass, none of
        // which interact with each other. A malformed `db.health_timeout` is exercised
        // separately below (it now hard-fails the whole command, so it can't
        // be bundled into this "successful bring-up" scenario anymore).
        const { layer, workdir, child } = setup({
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
        mkdirSync(join(workdir, "supabase", "templates"), { recursive: true });
        writeFileSync(join(workdir, "supabase", "templates", "confirmation.html"), "<html></html>");
        writeFileSync(
          join(workdir, "supabase", "templates", "custom_notice.html"),
          "<html></html>",
        );
        return Effect.gen(function* () {
          yield* legacyStart(flags());
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
            join(workdir, "supabase", "templates/custom_notice.html"),
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      // The backoff policy for "0s" performs exactly one immediate health
      // probe with no retries — this is NOT a 30s fallback. The mock's default route
      // heals on the very first check either way, so this only proves "0s" is
      // accepted and doesn't hang/fail, not the exact retry count.
      "accepts a zero db.health_timeout without hanging, and blanks webauthn fields on an empty [auth.webauthn] section",
      () => {
        const { layer } = setup({
          configContents: 'project_id = "demo"\n[db]\nhealth_timeout = "0s"\n[auth.webauthn]\n',
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails config loading on an unparseable db.health_timeout before any Docker work, matching Go's Config.Load",
      () => {
        // db.health_timeout decodes in the same unconditional pass as every other
        // duration field, before any Docker work — a malformed value fails before
        // network/image/Postgres work, so rollback (only reached on a genuine run
        // failure) never even runs. Resolved eagerly here, alongside the other
        // config-override fields, for the same reason — no containers should ever be created.
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[db]\nhealth_timeout = "not-a-duration"\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("failed to parse config");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails on an invalid storage.file_size_limit even when storage is excluded, matching Go's Config.Load",
      () => {
        // The size decoder rejects a malformed file_size_limit unconditionally at
        // config load, regardless of --exclude — this proves the eager validation in
        // start.handler.ts really is unconditional, not merely earlier-but-still-gated on
        // Storage actually running.
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[storage]\nfile_size_limit = "not-a-size"\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags({ exclude: ["storage"] })));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for storage.file_size_limit");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails on an invalid SUPABASE_STORAGE_S3_PROTOCOL_ENABLED even when storage is excluded, matching Go's Config.Load",
      () => {
        // `storage.s3_protocol.enabled` is a plain bool decoded unconditionally at
        // config load — same class of gap as storage.file_size_limit above,
        // now fixed the same way (hoisted eager wrapConfigOverride in start.handler.ts).
        const previous = process.env["SUPABASE_STORAGE_S3_PROTOCOL_ENABLED"];
        process.env["SUPABASE_STORAGE_S3_PROTOCOL_ENABLED"] = "not-a-bool";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags({ exclude: ["storage"] })));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for storage.s3_protocol.enabled");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined)
                delete process.env["SUPABASE_STORAGE_S3_PROTOCOL_ENABLED"];
              else process.env["SUPABASE_STORAGE_S3_PROTOCOL_ENABLED"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails on an invalid SUPABASE_STORAGE_ANALYTICS_ENABLED even when storage is excluded, matching Go's Config.Load",
      () => {
        // `storage.analytics.enabled` is the bool sibling of the
        // max_namespaces/max_tables/max_catalogs uint fields below, decoded
        // unconditionally at config load — same class of gap as
        // storage.s3_protocol.enabled above, now fixed the same way (hoisted eager
        // wrapConfigOverride in start.handler.ts).
        const previous = process.env["SUPABASE_STORAGE_ANALYTICS_ENABLED"];
        process.env["SUPABASE_STORAGE_ANALYTICS_ENABLED"] = "not-a-bool";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags({ exclude: ["storage"] })));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for storage.analytics.enabled");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_STORAGE_ANALYTICS_ENABLED"];
              else process.env["SUPABASE_STORAGE_ANALYTICS_ENABLED"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails on an invalid SUPABASE_STORAGE_ANALYTICS_MAX_NAMESPACES even when storage is excluded, matching Go's Config.Load",
      () => {
        // `storage.analytics.max_namespaces` is a plain uint decoded
        // unconditionally at config load — same class of gap as
        // storage.s3_protocol.enabled above, now fixed the same way
        // (hoisted eager wrapConfigOverride in start.handler.ts).
        const previous = process.env["SUPABASE_STORAGE_ANALYTICS_MAX_NAMESPACES"];
        process.env["SUPABASE_STORAGE_ANALYTICS_MAX_NAMESPACES"] = "not-a-uint";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags({ exclude: ["storage"] })));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for storage.analytics.max_namespaces");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined)
                delete process.env["SUPABASE_STORAGE_ANALYTICS_MAX_NAMESPACES"];
              else process.env["SUPABASE_STORAGE_ANALYTICS_MAX_NAMESPACES"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails on an invalid SUPABASE_STORAGE_ANALYTICS_MAX_TABLES even when storage is excluded, matching Go's Config.Load",
      () => {
        // Same gap as storage.analytics.max_namespaces above — `storage.analytics.max_tables`
        // decodes in the same config-load pass.
        const previous = process.env["SUPABASE_STORAGE_ANALYTICS_MAX_TABLES"];
        process.env["SUPABASE_STORAGE_ANALYTICS_MAX_TABLES"] = "not-a-uint";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags({ exclude: ["storage"] })));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for storage.analytics.max_tables");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined)
                delete process.env["SUPABASE_STORAGE_ANALYTICS_MAX_TABLES"];
              else process.env["SUPABASE_STORAGE_ANALYTICS_MAX_TABLES"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails on an invalid SUPABASE_STORAGE_ANALYTICS_MAX_CATALOGS even when storage is excluded, matching Go's Config.Load",
      () => {
        // Same gap as storage.analytics.max_namespaces above — `storage.analytics.max_catalogs`
        // decodes in the same config-load pass.
        const previous = process.env["SUPABASE_STORAGE_ANALYTICS_MAX_CATALOGS"];
        process.env["SUPABASE_STORAGE_ANALYTICS_MAX_CATALOGS"] = "not-a-uint";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags({ exclude: ["storage"] })));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for storage.analytics.max_catalogs");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined)
                delete process.env["SUPABASE_STORAGE_ANALYTICS_MAX_CATALOGS"];
              else process.env["SUPABASE_STORAGE_ANALYTICS_MAX_CATALOGS"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails on an invalid SUPABASE_STORAGE_VECTOR_MAX_BUCKETS even when storage is excluded, matching Go's Config.Load",
      () => {
        // `storage.vector.max_buckets` is a plain uint decoded in the same config-load pass as
        // storage.analytics.* above, unconditionally.
        const previous = process.env["SUPABASE_STORAGE_VECTOR_MAX_BUCKETS"];
        process.env["SUPABASE_STORAGE_VECTOR_MAX_BUCKETS"] = "not-a-uint";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags({ exclude: ["storage"] })));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for storage.vector.max_buckets");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_STORAGE_VECTOR_MAX_BUCKETS"];
              else process.env["SUPABASE_STORAGE_VECTOR_MAX_BUCKETS"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails on an invalid SUPABASE_STORAGE_VECTOR_MAX_INDEXES even when storage is excluded, matching Go's Config.Load",
      () => {
        // `storage.vector.max_indexes` is a plain uint decoded in the same config-load pass as
        // storage.vector.max_buckets above, unconditionally.
        const previous = process.env["SUPABASE_STORAGE_VECTOR_MAX_INDEXES"];
        process.env["SUPABASE_STORAGE_VECTOR_MAX_INDEXES"] = "not-a-uint";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags({ exclude: ["storage"] })));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for storage.vector.max_indexes");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_STORAGE_VECTOR_MAX_INDEXES"];
              else process.env["SUPABASE_STORAGE_VECTOR_MAX_INDEXES"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails on an invalid auth.sms.max_frequency even when auth is disabled, matching Go's Config.Load",
      () => {
        // Every GoTrue duration field decodes unconditionally, regardless of
        // auth.enabled — proving the eager validation covers fields beyond auth.email.max_frequency
        // and really is independent of whether GoTrue's own spec builder ever runs.
        const { layer, child } = setup({
          configContents:
            'project_id = "demo"\n[auth]\nenabled = false\n[auth.sms]\nmax_frequency = "not-a-duration"\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for auth.sms.max_frequency");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails on an invalid SUPABASE_AUTH_RATE_LIMIT_ANONYMOUS_USERS even when auth is disabled, matching Go's Config.Load",
      () => {
        // `auth.rate_limit.*` are plain uints decoded unconditionally at config
        // load — `resolveGotrueRateLimit` only throws via an env var
        // override (a bad TOML value is caught by @supabase/config's own schema first), so this
        // models the override directly, same as the storage.s3_protocol.enabled test above.
        const previous = process.env["SUPABASE_AUTH_RATE_LIMIT_ANONYMOUS_USERS"];
        process.env["SUPABASE_AUTH_RATE_LIMIT_ANONYMOUS_USERS"] = "not-a-uint";
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[auth]\nenabled = false\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for auth.rate_limit");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined)
                delete process.env["SUPABASE_AUTH_RATE_LIMIT_ANONYMOUS_USERS"];
              else process.env["SUPABASE_AUTH_RATE_LIMIT_ANONYMOUS_USERS"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails on an invalid SUPABASE_AUTH_WEB3_SOLANA_ENABLED even when auth is disabled, matching Go's Config.Load",
      () => {
        // `auth.web3.*.enabled` are plain bools decoded unconditionally at
        // config load — same override-only-throw reasoning as the rate_limit
        // test above.
        const previous = process.env["SUPABASE_AUTH_WEB3_SOLANA_ENABLED"];
        process.env["SUPABASE_AUTH_WEB3_SOLANA_ENABLED"] = "not-a-bool";
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[auth]\nenabled = false\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for auth.web3");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_AUTH_WEB3_SOLANA_ENABLED"];
              else process.env["SUPABASE_AUTH_WEB3_SOLANA_ENABLED"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails on an invalid SUPABASE_AUTH_OAUTH_SERVER_ENABLED even when auth is disabled, matching Go's Config.Load",
      () => {
        // `auth.oauth_server.enabled`/`allow_dynamic_registration` are plain bools decoded
        // unconditionally at config load — same
        // override-only-throw reasoning as the two tests above.
        const previous = process.env["SUPABASE_AUTH_OAUTH_SERVER_ENABLED"];
        process.env["SUPABASE_AUTH_OAUTH_SERVER_ENABLED"] = "not-a-bool";
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[auth]\nenabled = false\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for auth.oauth_server");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_AUTH_OAUTH_SERVER_ENABLED"];
              else process.env["SUPABASE_AUTH_OAUTH_SERVER_ENABLED"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails on an invalid SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED even when auth is disabled, matching Go's Config.Load",
      () => {
        // `auth.third_party.<provider>.enabled` are plain bools decoded unconditionally at
        // config load, same override-only-throw reasoning as the
        // web3/oauth_server tests above (review: PRRT_kwDOErm0O86WXFqj).
        const previous = process.env["SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED"];
        process.env["SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED"] = "not-a-bool";
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[auth]\nenabled = false\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for auth.third_party");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined)
                delete process.env["SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED"];
              else process.env["SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails on an invalid auth.passkey.enabled even when auth is disabled, matching Go's Config.Load",
      () => {
        // `auth.passkey`/`auth.webauthn` have no `@supabase/config` schema at all —
        // `auth.passkey.enabled` decodes unconditionally at config load via
        // `legacyResolveGotruePasskeyWebauthn`'s raw-document read, same override-only-throw
        // reasoning as the web3/oauth_server tests above, except the malformed value lives directly in
        // config.toml here since `@supabase/config` never sees (or rejects) this unmodeled field —
        // there's no schema-level bool coercion to catch it first.
        const { layer, child } = setup({
          configContents:
            'project_id = "demo"\n[auth]\nenabled = false\n[auth.passkey]\nenabled = "bad"\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for auth.passkey");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails on an invalid auth.external.<custom>.enabled even when auth is disabled, matching Go's Config.Load",
      () => {
        // `auth.external` is an open-ended provider map — an unmodeled/
        // custom provider name like `custom` is a legitimate config shape `@supabase/config`'s
        // schema silently drops at decode time (see the "custom auth.external providers" describe
        // block below for the accepted-value counterpart), so
        // `legacyResolveAuthExternalProviders`'s raw-document read is the only place this malformed
        // value is ever seen — same override-only-throw reasoning as the passkey test above.
        const { layer, child } = setup({
          configContents:
            'project_id = "demo"\n[auth]\nenabled = false\n[auth.external.custom]\nenabled = "bad"\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for auth.external");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails on a per-function env field, matching Go's Config.Load rejecting an unknown functions[slug] key",
      () => {
        // A per-function `env` key is rejected unconditionally at config
        // load, before any Docker work — the established error is
        // `'functions[foo]' has invalid keys: env`. `@supabase/config`'s own schema DOES model
        // `[functions.<slug>.env]` (a legitimate next/-only feature), so this must be a
        // legacy-only rejection.
        const { layer, child } = setup({
          configContents:
            'project_id = "demo"\n[functions.foo]\nenabled = true\n[functions.foo.env]\nFOO = "env(SOME_VAR)"\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("'functions[foo]' has invalid keys: env");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails on an invalid SUPABASE_EDGE_RUNTIME_POLICY even when edge-runtime is excluded, matching Go's Config.Load",
      () => {
        // `edge_runtime.policy` is a strict enum in @supabase/config's schema, so a bad TOML
        // value is already rejected at config load, before start.handler.ts runs — only the env
        // var override path (a plain string, unchecked by the schema) can reach
        // `legacyEnvOverrideEdgeRuntimePolicy`'s own throw, same reasoning as the GoTrue
        // override-only tests above.
        const previous = process.env["SUPABASE_EDGE_RUNTIME_POLICY"];
        process.env["SUPABASE_EDGE_RUNTIME_POLICY"] = "not-a-policy";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags({ exclude: ["edge-runtime"] })));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for edge_runtime.policy");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_EDGE_RUNTIME_POLICY"];
              else process.env["SUPABASE_EDGE_RUNTIME_POLICY"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails on an invalid SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT even when edge-runtime is excluded, matching Go's Config.Load",
      () => {
        // `edge_runtime.inspector_port` is a plain number in @supabase/config's schema, so a bad
        // TOML value is already rejected at config load — only the env var override path (a
        // string parsed by `envOverridePort`) can throw here, same reasoning as the policy test
        // above.
        const previous = process.env["SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT"];
        process.env["SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT"] = "not-a-port";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags({ exclude: ["edge-runtime"] })));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for edge_runtime.inspector_port");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined)
                delete process.env["SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT"];
              else process.env["SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "warns about a Windows npipe Docker daemon before starting Vector, in text mode, and excludes it from the health watch list",
      () => {
        // `legacyResolveDockerDaemonHost` checks `DOCKER_HOST` before ever shelling out to
        // `docker context inspect`, so setting it directly is a reliable way to force the
        // npipe branch without needing a real Windows Docker Desktop context.
        const previousDockerHost = process.env["DOCKER_HOST"];
        process.env["DOCKER_HOST"] = "npipe:////./pipe/docker_engine";
        const { layer, out } = setup();
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          expect(out.stderrText).toContain(
            "Analytics on Windows requires Docker daemon exposed on tcp://localhost:2375.",
          );
          expect(out.stderrText).toContain("Started");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previousDockerHost === undefined) delete process.env["DOCKER_HOST"];
              else process.env["DOCKER_HOST"] = previousDockerHost;
            }),
          ),
        );
      },
    );
  });

  describe("service gating", () => {
    it.live(
      "skips analytics services (logflare + vector) together when analytics.enabled = false",
      () => {
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[analytics]\nenabled = false\n',
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const createdNames = createdContainerNames(child.spawned);
          expect(createdNames.some((name) => name.includes("_analytics_"))).toBe(false);
          expect(createdNames.some((name) => name.includes("_vector_"))).toBe(false);
          expect(createdNames.some((name) => name.includes("_kong_"))).toBe(true);
          expect(createdNames.some((name) => name.includes("_auth_"))).toBe(true);
          expect(createdNames.some((name) => name.includes("_storage_"))).toBe(true);
          expect(createdNames.some((name) => name.includes("_studio_"))).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "skips storage and imgproxy together when storage.enabled = false, even with image_transformation on",
      () => {
        // ImgProxy mounts Storage's own volumes (`start.gates.ts`'s `imgproxy: storage && ...`
        // dependency) — disabling storage must take ImgProxy down with it, even though
        // `storage.image_transformation.enabled` on its own would otherwise turn ImgProxy on.
        const { layer, child } = setup({
          configContents:
            'project_id = "demo"\n[storage]\nenabled = false\n[storage.image_transformation]\nenabled = true\n',
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const createdNames = createdContainerNames(child.spawned);
          expect(createdNames.some((name) => name.includes("_storage_"))).toBe(false);
          expect(createdNames.some((name) => name.includes("_imgproxy_"))).toBe(false);
          expect(createdNames.some((name) => name.includes("_kong_"))).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "ignores SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED when [storage.image_transformation] is absent from config.toml",
      () => {
        // `storage.image_transformation` is a nil-unless-declared field —
        // with no `[storage.image_transformation]` table, the env var is
        // never even looked up, so ImgProxy must stay off even though
        // storage itself is enabled.
        const previous = process.env["SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED"];
        process.env["SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED"] = "true";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const createdNames = createdContainerNames(child.spawned);
          expect(createdNames.some((name) => name.includes("_storage_"))).toBe(true);
          expect(createdNames.some((name) => name.includes("_imgproxy_"))).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) {
                delete process.env["SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED"];
              } else {
                process.env["SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED"] = previous;
              }
            }),
          ),
        );
      },
    );

    it.live(
      "starts Kong and Realtime even when api.enabled is false, since only Postgrest depends on it",
      () => {
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[api]\nenabled = false\n',
          httpClientLayer: unusedHttpClientLayer,
        });
        return Effect.gen(function* () {
          // `edge-runtime` excluded so its own HTTP readiness probe never reaches
          // `unusedHttpClientLayer` — this scenario is only about Postgrest/Kong/
          // Realtime's `api.enabled` independence.
          yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
          const createdNames = createdContainerNames(child.spawned);
          expect(createdNames.some((name) => name.includes("_kong_"))).toBe(true);
          expect(createdNames.some((name) => name.includes("_realtime_"))).toBe(true);
          expect(createdNames.some((name) => name.includes("_rest_"))).toBe(false);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "excluding a single --exclude key skips exactly that container and starts every other excludable service",
      () => {
        expect(new Set(LEGACY_START_EXCLUDABLE_KEYS)).toEqual(
          new Set(Object.keys(CONTAINER_SUFFIX_BY_EXCLUDE_KEY)),
        );

        return Effect.gen(function* () {
          for (const excludeKey of LEGACY_START_EXCLUDABLE_KEYS) {
            const { layer, child } = setup({
              configContents:
                'project_id = "demo"\n[storage.image_transformation]\nenabled = true\n[db.pooler]\nenabled = true\n',
            });
            yield* legacyStart(flags({ exclude: [excludeKey] })).pipe(Effect.provide(layer));

            const createdNames = createdContainerNames(child.spawned);
            expect(
              createdNames.filter((name) => name.includes("_db_")),
              excludeKey,
            ).toHaveLength(1);
            const missing = missingSuffixesForExcludeKey(excludeKey);
            for (const suffix of ALL_EXCLUDABLE_SUFFIXES) {
              const shouldExist = !missing.includes(suffix);
              const actuallyExists = createdNames.some((name) => name.includes(`_${suffix}_`));
              expect(actuallyExists, `excludeKey=${excludeKey} suffix=${suffix}`).toBe(shouldExist);
            }
          }
        });
      },
      15_000,
    );
  });

  describe("fresh volume: DB setup + bucket seeding", () => {
    /** The three PG15+ one-shot migrate jobs (`legacyRunFreshDbSetup`'s `LegacyDockerRun` calls) — a plain `docker run --rm ...`, never `-d`, distinct from Edge Runtime's own detached `docker run -d`. */
    function dbSetupJobCalls(spawned: ReadonlyArray<SpawnRecord>): ReadonlyArray<SpawnRecord> {
      return spawned.filter((s) => s.args[0] === "run" && s.args[1] === "--rm");
    }

    it.live(
      "triggers the SetupLocalDatabase-equivalent pipeline (PG15+ one-shot migrate jobs) on a fresh volume",
      () => {
        const { layer, out, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
        return Effect.gen(function* () {
          // Excludes edge-runtime to keep this scenario focused on the fresh-volume
          // DB-setup path only.
          yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
          expect(out.stderrText).toContain("Initialising schema...");
          // Default config: realtime, storage, and auth are all enabled.
          expect(dbSetupJobCalls(child.spawned)).toHaveLength(3);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "caches the migrations catalog after a fresh-volume setup for the legacy engine",
      () => {
        const { layer, out, workdir, edgeRunCalls } = setup({
          configContents: 'project_id = "demo"\n[experimental.pgdelta]\nenabled = true\n',
          route: freshVolumeRoute(defaultRoute()),
          catalogStdout: '{"snapshot":"ok"}',
        });
        writeFileSync(join(workdir, "supabase", ".env"), "SUPABASE_USE_PG_DELTA_NEXT=false\n");
        return Effect.gen(function* () {
          yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
          expect(out.stderrText).not.toContain("failed to cache migrations catalog");
          // Runs once, immediately AFTER the fresh-volume migrate+seed pipeline.
          expect(edgeRunCalls).toHaveLength(1);
          const tempDir = join(workdir, "supabase", ".temp", "pgdelta");
          const catalogFiles = readdirSync(tempDir).filter((name) =>
            name.startsWith("catalog-local-migrations-"),
          );
          expect(catalogFiles).toHaveLength(1);
          expect(readFileSync(join(tempDir, catalogFiles[0]!), "utf8")).toBe('{"snapshot":"ok"}');
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "warns without failing supabase start when the migrations-catalog export fails on a fresh volume",
      () => {
        const { layer, out, workdir } = setup({
          configContents: 'project_id = "demo"\n[experimental.pgdelta]\nenabled = true\n',
          route: freshVolumeRoute(defaultRoute()),
          catalogExportFailWith: "edge-runtime script produced no output",
        });
        writeFileSync(join(workdir, "supabase", ".env"), "SUPABASE_USE_PG_DELTA_NEXT=false\n");
        return Effect.gen(function* () {
          const exit = yield* legacyStart(flags({ exclude: ["edge-runtime"] })).pipe(Effect.exit);
          expect(Exit.isSuccess(exit)).toBe(true);
          expect(out.stderrText).toContain(
            "Warning: failed to cache migrations catalog: edge-runtime script produced no output",
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "does not attempt to cache the migrations catalog on a fresh volume when pg-delta is disabled",
      () => {
        const { layer, out, edgeRunCalls } = setup({ route: freshVolumeRoute(defaultRoute()) });
        return Effect.gen(function* () {
          yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
          expect(edgeRunCalls).toHaveLength(0);
          expect(out.stderrText).not.toContain("failed to cache migrations catalog");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "resolves an excluded service's migrate-job image through a project-dotenv-only registry override",
      () => {
        // The auth/realtime/storage migrate jobs run regardless of `--exclude`, but
        // `--exclude gotrue` removes the gotrue image from `imagePlan`, which used to
        // make its migrate-job image fall back to `LegacyDockerRun`'s
        // ambient-`process.env`-only registry resolver — invisible to a
        // registry override that only exists in the project's own `.env` file.
        const workdir = tempRoot.current;
        const { layer, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
        // `loadProjectEnvironment`'s `envPath` is `<workdir>/supabase/.env` (`findProjectPaths`),
        // written after `setup()` so the `supabase/` dir (created by `writeConfig`) already exists.
        writeFileSync(
          join(workdir, "supabase", ".env"),
          "SUPABASE_INTERNAL_IMAGE_REGISTRY=registry.example.com\n",
        );
        return Effect.gen(function* () {
          yield* legacyStart(flags({ exclude: ["gotrue"] }));
          expect(dbSetupJobCalls(child.spawned)).toHaveLength(3);
          const authMigrateJob = dbSetupJobCalls(child.spawned).find((s) =>
            s.args.some((arg) => arg.includes("gotrue")),
          );
          expect(
            authMigrateJob?.args.some((arg) => arg.startsWith("registry.example.com/supabase/")),
          ).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "does not attempt to resolve an excluded service's migrate-job image on a non-fresh-volume restart",
      () => {
        // The pre-pull step only ever touches non-excluded services, and the
        // one-shot setup-job images are resolved lazily, only from inside
        // `initSchema15` when it actually runs — a fresh volume AND
        // PG15+. On an ordinary restart (this test's default, non-fresh-volume setup),
        // `--exclude storage-api` must not even attempt to resolve Storage's image, or an
        // unavailable/rate-limited Storage image would fail `start` even though nothing
        // in this run needs it.
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
        const { layer, child } = setup({ route });
        return Effect.gen(function* () {
          yield* legacyStart(flags({ exclude: ["storage-api"] }));
          const createdNames = createdContainerNames(child.spawned);
          expect(createdNames.some((name) => name.includes("_storage_"))).toBe(false);
          expect(createdNames.some((name) => name.includes("_kong_"))).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("skips the SetupLocalDatabase-equivalent pipeline on a non-fresh volume", () => {
      const { layer, out, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
        expect(out.stderrText).not.toContain("Initialising schema...");
        expect(dbSetupJobCalls(child.spawned)).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "fails on an undecryptable [db.vault] secret even on a non-fresh volume, matching Go's Config.Load",
      () => {
        // `legacyCheckDbToml`'s own internal call inside `legacyRunFreshDbSetup` only
        // runs on a fresh volume — an undecryptable `[db.vault]`
        // secret (a DB-specific field `@supabase/config`'s own schema never decrypts, only
        // `legacyCheckDbToml`'s pipeline does) must still fail eagerly, before any Docker work,
        // on an ordinary restart against an existing (non-fresh) volume: every `encrypted:`
        // value decrypts unconditionally regardless of volume state.
        const previous = process.env["DOTENV_PRIVATE_KEY"];
        delete process.env["DOTENV_PRIVATE_KEY"];
        const encrypted =
          "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";
        const { layer, child } = setup({
          configContents: `project_id = "demo"\n[db.vault]\nmy_secret = "${encrypted}"\n`,
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("failed to parse config: missing private key");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["DOTENV_PRIVATE_KEY"];
              else process.env["DOTENV_PRIVATE_KEY"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails on a bucket's invalid file_size_limit even on a non-fresh volume, matching Go's Config.Load",
      () => {
        // Same class of gap as the `[db.vault]` test above: the per-bucket `file_size_limit`
        // (the same size decode hook as the storage-level default) was previously only
        // parsed deep inside `legacySeedBucketsRun`, reached only on a fresh volume with Storage
        // actually seeding — a malformed value on an ordinary restart against an existing
        // (non-fresh) volume went completely unvalidated. `legacyCheckDbToml` now catches it
        // eagerly, before any Docker work, regardless of volume state.
        const { layer, child } = setup({
          configContents:
            'project_id = "demo"\n[storage.buckets.avatars]\nfile_size_limit = "bogus"\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyDbConfigLoadError");
            expect(serialized).toContain(
              "failed to parse config: invalid storage.buckets.avatars.file_size_limit.",
            );
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live('prints "Starting database..." on a fresh volume, before Postgres is created', () => {
      const { layer, out } = setup({ route: freshVolumeRoute(defaultRoute()) });
      return Effect.gen(function* () {
        yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
        expect(out.stderrText).toContain("Starting database...\n");
        expect(out.stderrText).not.toContain("Starting database from backup...");
        expect(out.stderrText.indexOf("Starting database...\n")).toBeLessThan(
          out.stderrText.indexOf("Initialising schema..."),
        );
      }).pipe(Effect.provide(layer));
    });

    it.live(
      'prints "Starting database from backup..." on a restart (an already-existing volume)',
      () => {
        const { layer, out } = setup();
        return Effect.gen(function* () {
          yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
          expect(out.stderrText).toContain("Starting database from backup...\n");
          expect(out.stderrText).not.toContain("Starting database...\n");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "still writes supabase/.branches/_current_branch on a restart, even though the fresh-volume DB setup is skipped",
      () => {
        const { layer, workdir } = setup();
        return Effect.gen(function* () {
          yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
          const content = readFileSync(
            join(workdir, "supabase", ".branches", "_current_branch"),
            "utf8",
          );
          expect(content).toBe("main");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("seeds a configured bucket on a fresh volume with storage enabled", () => {
      const http = mockStorageBucketHttpClient();
      const { layer } = setup({
        configContents: 'project_id = "demo"\n[storage.buckets.avatars]\npublic = false\n',
        route: freshVolumeRoute(defaultRoute()),
        httpClientLayer: http.layer,
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
        expect(http.createdBucketRequests).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "does not seed a configured bucket on a non-fresh volume, even with storage enabled",
      () => {
        const http = mockStorageBucketHttpClient();
        const { layer } = setup({
          configContents: 'project_id = "demo"\n[storage.buckets.avatars]\npublic = false\n',
          httpClientLayer: http.layer,
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
          expect(http.createdBucketRequests).toHaveLength(0);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "seeds against the env-overridden SUPABASE_API_PORT, not config.toml's raw port",
      () => {
        // legacySeedBucketsRun previously reloaded config.toml independently instead of
        // reusing start's own already env-overridden config, so a SUPABASE_API_PORT
        // override that actually brought Kong up on a different port never reached
        // the bucket-seeding gateway's base URL.
        const previous = process.env["SUPABASE_API_PORT"];
        process.env["SUPABASE_API_PORT"] = "65432";
        const http = mockStorageBucketHttpClient();
        const { layer } = setup({
          configContents: 'project_id = "demo"\n[storage.buckets.avatars]\npublic = false\n',
          route: freshVolumeRoute(defaultRoute()),
          httpClientLayer: http.layer,
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
          expect(http.createdBucketRequests).toHaveLength(1);
          expect(http.createdBucketRequests[0]).toContain(":65432/");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_API_PORT"];
              else process.env["SUPABASE_API_PORT"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "seeds against the env-overridden SUPABASE_API_EXTERNAL_URL, not config.toml's raw value",
      () => {
        // `effectiveLocalStorageConfig` previously left `api.external_url` as the raw,
        // un-overridden config value, so a `SUPABASE_API_EXTERNAL_URL` override that
        // actually brought Kong/GoTrue up under a different external URL never reached
        // the bucket-seeding gateway's base URL.
        const previous = process.env["SUPABASE_API_EXTERNAL_URL"];
        process.env["SUPABASE_API_EXTERNAL_URL"] = "http://override.example.com:9999";
        const http = mockStorageBucketHttpClient();
        const { layer } = setup({
          configContents: 'project_id = "demo"\n[storage.buckets.avatars]\npublic = false\n',
          route: freshVolumeRoute(defaultRoute()),
          httpClientLayer: http.layer,
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
          expect(http.createdBucketRequests).toHaveLength(1);
          expect(http.createdBucketRequests[0]).toContain("override.example.com:9999");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_API_EXTERNAL_URL"];
              else process.env["SUPABASE_API_EXTERNAL_URL"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "seeds a bucket's default file_size_limit from the env-overridden SUPABASE_STORAGE_FILE_SIZE_LIMIT",
      () => {
        // `effectiveLocalStorageConfig` previously left `storage.file_size_limit` as the
        // raw, un-overridden config value, so `legacySeedBucketsRun`'s per-bucket default
        // (for a bucket with no explicit `file_size_limit` of its own) never reflected an
        // env/dotenv-only `SUPABASE_STORAGE_FILE_SIZE_LIMIT` override.
        const previous = process.env["SUPABASE_STORAGE_FILE_SIZE_LIMIT"];
        process.env["SUPABASE_STORAGE_FILE_SIZE_LIMIT"] = "10MiB";
        const http = mockStorageBucketHttpClient();
        const { layer } = setup({
          configContents: 'project_id = "demo"\n[storage.buckets.avatars]\npublic = false\n',
          route: freshVolumeRoute(defaultRoute()),
          httpClientLayer: http.layer,
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
          expect(http.createdBucketBodies).toHaveLength(1);
          expect(
            (http.createdBucketBodies[0] as { file_size_limit?: number })?.file_size_limit,
          ).toBe(10 * 1024 * 1024);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_STORAGE_FILE_SIZE_LIMIT"];
              else process.env["SUPABASE_STORAGE_FILE_SIZE_LIMIT"] = previous;
            }),
          ),
        );
      },
    );
  });

  describe("edge runtime", () => {
    /** Edge Runtime's own bring-up (`legacyStartEdgeRuntimeContainer`) is a `docker create` → `docker cp` (main-service archive) → `docker start` sequence; its create is the one naming the `_edge_runtime_` container, distinguishing it from every other service's `legacyCreateContainer` create. */
    function edgeRuntimeRunCalls(spawned: ReadonlyArray<SpawnRecord>): ReadonlyArray<SpawnRecord> {
      return spawned.filter((s) => isEdgeRuntimeCreate(s.args));
    }

    it.live("creates and starts a real container when enabled and not excluded", () => {
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
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
      }).pipe(Effect.provide(layer));
    });

    it.live("--exclude edge-runtime skips its container entirely", () => {
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
        expect(edgeRuntimeRunCalls(child.spawned)).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "keeps the host-side staged env artifacts after a successful bring-up (no eager cleanup)",
      () => {
        // Staged under `<workdir>/supabase/.temp/start-secrets/<container>/` so a later
        // `stop`/rollback can reclaim it; the bootstrap template is no longer part of it.
        const { layer, child, workdir } = setup();
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const runArgs = edgeRuntimeRunCalls(child.spawned)[0]?.args ?? [];
          const envFileIndex = runArgs.indexOf("--env-file");
          const envFilePath = envFileIndex === -1 ? undefined : runArgs[envFileIndex + 1];
          expect(envFilePath).toBeDefined();
          const stagingRoot = join(workdir, "supabase", ".temp", "start-secrets");
          expect(envFilePath?.startsWith(stagingRoot)).toBe(true);
          try {
            expect(existsSync(envFilePath ?? "")).toBe(true);
            // `<stagingRoot>/<container>/env/docker.env` → the staging dir is two levels up.
            const containerStagingDir = join(envFilePath ?? "", "..", "..");
            expect(existsSync(join(containerStagingDir, "main"))).toBe(false);
          } finally {
            rmSync(stagingRoot, { recursive: true, force: true });
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "logs 'Skipped serving Function' for a disabled function via Studio's bind mounts, even with Edge Runtime excluded",
      () => {
        // `resolveFunctionBindMounts` backs Studio's function bind mounts
        // unconditionally of Edge Runtime being enabled (see
        // `start.handler.ts`'s "studio" case doc comment) — the skip line still
        // logs via that path alone here, since Edge Runtime itself never runs to log it too.
        const workdir = tempRoot.current;
        mkdirSync(join(workdir, "supabase", "functions", "foo"), { recursive: true });
        writeFileSync(join(workdir, "supabase", "functions", "foo", "index.ts"), "export {};\n");
        const { layer, out } = setup({
          configContents: 'project_id = "demo"\n[functions.foo]\nenabled = false\n',
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
          expect(out.stderrText).toContain("Skipped serving Function: foo");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              rmSync(join(workdir, "supabase", "functions"), { recursive: true, force: true });
            }),
          ),
        );
      },
    );

    it.live(
      "does not pick up an unrelated ancestor project's functions for a config-less --workdir subdirectory",
      () => {
        // `--workdir`/`SUPABASE_WORKDIR` pointing at a subdirectory with no
        // `supabase/config.toml` of its own is a legitimate, reachable state
        // (see `start.e2e.test.ts`'s "absent config" comment) — `start` still
        // proceeds, resolving the main config with `search: false`
        // (`legacy-local-project-context.ts`). `inferFunctionsManifest`'s own
        // `search: false` here (CLI-1323 functions-manifest fix) must keep an
        // UNRELATED ancestor project's `supabase/functions` from silently
        // winning for this workdir, mirroring that same `search: false`.
        const ancestorRoot = tempRoot.current;
        mkdirSync(join(ancestorRoot, "supabase", "functions", "foo"), { recursive: true });
        writeFileSync(
          join(ancestorRoot, "supabase", "functions", "foo", "index.ts"),
          "export {};\n",
        );
        writeFileSync(
          join(ancestorRoot, "supabase", "config.toml"),
          'project_id = "ancestor"\n[functions.foo]\nenabled = true\n',
        );
        const workdir = join(ancestorRoot, "nested", "workdir");
        mkdirSync(workdir, { recursive: true });

        const { layer, out, child } = setup({ workdir, skipConfig: true });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const runArgs = edgeRuntimeRunCalls(child.spawned)[0]?.args ?? [];
          const bindValues = runArgs.flatMap((arg, i) => (runArgs[i - 1] === "-v" ? [arg] : []));
          expect(bindValues.some((bind) => bind.includes(join("functions", "foo")))).toBe(false);
          expect(out.stderrText).not.toContain("foo");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              rmSync(join(ancestorRoot, "supabase", "functions"), { recursive: true, force: true });
            }),
          ),
        );
      },
    );
  });

  describe("image pull", () => {
    it.live(
      "retries a rate-limited image pull and succeeds",
      () => {
        const pullAttempts = new Map<string, number>();
        const base = defaultRoute();
        const route = (args: ReadonlyArray<string>): RouteResult => {
          // Force every image through the pull path instead of the "already cached" shortcut —
          // a confirmed "no such image" (not merely a non-zero exit) is what tells
          // `hasLocalImage` this is a genuine cache miss rather than some other inspect
          // failure, which now fails fast instead of falling through to a pull.
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
        const { layer, out, child } = setup({ route });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const kongPulls = child.spawned.filter(
            (s) => s.args[0] === "pull" && (s.args[1] ?? "").includes("kong"),
          );
          expect(kongPulls.length).toBeGreaterThanOrEqual(2);
          expect(out.stderrText).toContain("Started");
        }).pipe(Effect.provide(layer));
      },
      10_000,
    );

    it.live(
      "fails with a pull error once all registry candidates are exhausted, without a rollback (nothing was created yet)",
      () => {
        // Image pre-pull (`legacyEnsureImagesCached`) runs entirely before `bringUp` creates
        // the network or any container, so a pull failure here has nothing to roll back —
        // unlike a failure inside `bringUp` itself (see the "rollback" describe block below).
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
        const { layer, child } = setup({ route });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyImagePrepullError");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
          expect(rollbackWasAttempted(child.spawned)).toBe(false);
        }).pipe(Effect.provide(layer));
      },
      45_000,
    );

    it.live(
      "still fails when the daemon dies mid-pre-pull under --ignore-health-check — Go's exit-0 swallow is an unintended quirk this port deliberately does not reproduce (CLI-1987)",
      () => {
        // Historically, matching any `errors.Join`-shaped error — which
        // accidentally includes `ensureImagesCached`'s joined pull errors — meant
        // `--ignore-health-check` swallowed a total pre-pull failure, printing
        // "Started supabase local development setup." + the status table, and
        // exiting 0 with no container running. Ruled an unintended quirk
        // (CLI-1987): this port keeps the failure fatal regardless of the flag —
        // no success banner, no status table on stdout, and no rollback (nothing
        // was created yet). This scenario models the daemon-becoming-unreachable
        // trigger: `hasLocalImage` (`legacy-docker-image-resolve.ts`) fails
        // IMMEDIATELY on a daemon-unreachable `image inspect` stderr — no
        // registry-candidate retries, no real 4s/8s backoff sleeps (review
        // r3689619133) — while the flagless test above already pins the other
        // trigger, pull-retry exhaustion. Both funnel into the same joined
        // `LegacyImagePrepullError` (`lib/image-prepull.ts`). See
        // `legacyIsUnhealthyStartError`'s doc comment (`start.rollback.ts`) and
        // `SIDE_EFFECTS.md`'s "Notes" before changing this behavior.
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
        const { layer, out, child } = setup({ route });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags({ ignoreHealthCheck: true })));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyImagePrepullError");
          }
          expect(out.stderrText).not.toContain("Started");
          expect(out.stderrText).not.toContain("Local dev security notice");
          expect(out.stdoutText).toBe("");
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
          expect(rollbackWasAttempted(child.spawned)).toBe(false);
        }).pipe(Effect.provide(layer));
      },
      45_000,
    );
  });

  describe("rollback on bring-up failure", () => {
    it.live(
      "rolls back on a SIGINT-style interruption mid-bring-up, matching Go's context.Canceled rollback",
      () => {
        // Rollback on Ctrl-C: every command's context is wrapped so a SIGINT
        // produces a genuine interrupt, and rollback runs on ANY failure,
        // including that interrupt. The native
        // port installs no signal handling of its own, so this relies entirely on the global
        // `signalAwareProgram` wrapper (`shared/cli/run.ts`) calling `Fiber.interrupt`, and on
        // rollback being wired via `Effect.onError` (not `Effect.tapError`, which never sees a
        // pure interrupt's `Cause`).
        //
        // Marking the `db` container never-healthy (mirroring the neighboring "post-bring-up
        // bulk health-check" test below) keeps `bringUp`'s own Postgres health-check wait
        // genuinely retrying on its real 1-second `Schedule.spaced` backoff, rather than relying
        // on merely observing a `create` call: `mockStartContainerCliSpawner`'s synchronous,
        // zero-delay mock lets a whole bring-up (10+ containers, no real waits of its own) run to
        // full completion inside `Effect.forkChild({ startImmediately: true })`'s synchronous
        // startup window, before this test's own polling loop ever gets scheduled — making
        // `Fiber.interrupt` a no-op on an already-succeeded fiber and `rollbackWasAttempted`
        // flakily `false`.
        const neverHealthy = new Set<string>();
        const route = defaultRoute({ neverHealthy });
        let dbContainerId: string | undefined;
        const { layer, child } = setup({
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
        return Effect.gen(function* () {
          const fiber = yield* legacyStart(flags()).pipe(
            Effect.provide(layer),
            Effect.forkChild({ startImmediately: true }),
          );
          // Wait until Postgres's own health check has actually probed the never-healthy `db`
          // container at least once — proving the fiber is genuinely suspended inside
          // `bringUp`'s health-check retry loop, not merely past the `create` call.
          while (
            dbContainerId === undefined ||
            !child.spawned.some(
              (s) =>
                s.args[0] === "container" && s.args[1] === "inspect" && s.args[2] === dbContainerId,
            )
          ) {
            yield* Effect.sleep("5 millis");
          }
          // `Fiber.interrupt` only resolves once the target fiber (and its finalizers,
          // including the `Effect.onError` rollback) has fully completed.
          yield* Fiber.interrupt(fiber);
          expect(rollbackWasAttempted(child.spawned)).toBe(true);
        });
      },
    );

    it.live(
      "rolls back on a SIGINT-style interruption during the post-bring-up bulk health-check wait",
      () => {
        // Regression test for the post-bring-up tail rollback fix: before it, the ONLY
        // `Effect.onError` rollback wrapper covered `bringUp` itself (see the test above),
        // which already resolves the instant every container has been created — a fiber
        // interrupt landing anywhere in the tail that follows (the bulk health-check wait
        // below, the `--ignore-health-check` storage-only recheck-and-seed, the success-path
        // bucket seed, or the `cli_stack_started` capture) would slip past that earlier
        // wrapper entirely and never call `legacyRollbackStart`. Marking `auth` as
        // never-healthy (mirroring the "non-Postgres service never becomes healthy" scenario
        // below) keeps `legacyWaitForHealthyServices` genuinely retrying on its real 1-second
        // `Schedule.spaced` backoff — not hung on `Effect.never` — so interrupting the fiber
        // right after its first `container inspect` of that container lands the interrupt
        // while still inside this exact step, not before "Waiting for health checks..." prints
        // and not after the step has already failed/timed out on its own.
        const neverHealthy = new Set<string>();
        const route = defaultRoute({ neverHealthy });
        let authContainerId: string | undefined;
        const { layer, child } = setup({
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
          // Sidesteps the PostgREST/Edge Runtime HTTP-HEAD readiness probes entirely, so this
          // scenario only exercises the Docker-inspect health path (mirrors the
          // non-interrupt-based scenario below).
          httpClientLayer: unusedHttpClientLayer,
        });
        return Effect.gen(function* () {
          const fiber = yield* legacyStart(flags({ exclude: ["postgrest", "edge-runtime"] })).pipe(
            Effect.provide(layer),
            Effect.forkChild({ startImmediately: true }),
          );
          // Wait until the bulk health check has actually probed the never-healthy auth
          // container at least once — proving the fiber is genuinely suspended inside
          // `legacyWaitForHealthyServices`'s retry loop, not merely past the "Waiting for
          // health checks..." message that precedes it.
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
      },
    );

    it.live("fails and rolls back on a network create failure", () => {
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
      const { layer, child } = setup({ route });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = JSON.stringify(exit.cause);
          expect(serialized).toContain("LegacyNetworkCreateError");
          expect(serialized).toContain("failed to create docker network");
        }
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        expect(rollbackWasAttempted(child.spawned)).toBe(true);
        expect(child.spawned.some((s) => s.args[0] === "network" && s.args[1] === "prune")).toBe(
          true,
        );
      }).pipe(Effect.provide(layer));
    });

    it.live("fails and rolls back on a container create failure", () => {
      const base = defaultRoute();
      const route = (args: ReadonlyArray<string>): RouteResult => {
        if (args[0] === "create") {
          return { exitCode: 1, stderr: ["Error: no space left on device"] };
        }
        return base(args);
      };
      const { layer, child } = setup({ route });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(legacyStart(flags()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const serialized = JSON.stringify(exit.cause);
          expect(serialized).toContain("LegacyContainerCreateError");
          expect(serialized).toContain("failed to create docker container");
        }
        expect(rollbackWasAttempted(child.spawned)).toBe(true);
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "fails and rolls back on a container start failure, surfacing the port-conflict suggestion",
      () => {
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
        const { layer, child } = setup({ route });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyContainerStartError");
            expect(serialized).toContain("port is already allocated");
            expect(serialized).toContain(
              "Try stopping the project or container already using 0.0.0.0:54322",
            );
          }
          expect(rollbackWasAttempted(child.spawned)).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails on a malformed auth.email.max_frequency before any Docker work, matching Go's Config.Load",
      () => {
        // `auth.email.max_frequency` is a plain, unvalidated string in `@supabase/config`'s
        // schema. It decodes in the same unconditional config-load pass as every
        // other duration field, before any Docker work — this is now validated
        // eagerly here too (see the `resolvedEmail` validation in start.handler.ts), so a
        // malformed value fails before the network/Postgres/Kong/GoTrue sequence ever begins,
        // not partway through it.
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[auth.email]\nmax_frequency = "not-a-duration"\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for auth.email.max_frequency");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "fails with a typed config error on a malformed auth.email override even when auth itself is disabled",
      () => {
        // `legacyResolveLocalConfigValues` only validates `auth.email.*` overrides inside its
        // own `authEnabled` branch, so with auth disabled the unwrapped `legacyResolveAuthEmail`
        // call in `start.handler.ts` (used unconditionally for Kong's template mounts) becomes
        // the FIRST place `SUPABASE_AUTH_EMAIL_OTP_LENGTH` gets parsed — a synchronous throw
        // there would surface as an uncaught Effect defect instead. Unlike the max_frequency
        // case above, this override is read before any network/container work starts, so
        // there is nothing yet for rollback to prune — the point of this test is solely that
        // the typed LegacyStartInvalidConfigError surfaces instead of a defect.
        const previous = process.env["SUPABASE_AUTH_EMAIL_OTP_LENGTH"];
        process.env["SUPABASE_AUTH_EMAIL_OTP_LENGTH"] = "abc";
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[auth]\nenabled = false\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
          }
          expect(child.spawned).toHaveLength(0);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_AUTH_EMAIL_OTP_LENGTH"];
              else process.env["SUPABASE_AUTH_EMAIL_OTP_LENGTH"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails with a typed config error on a malformed auth.sms override even when auth itself is disabled",
      () => {
        // `legacyResolveLocalConfigValues` only validates `auth.sms.*` overrides inside its
        // own `authEnabled` branch, so with auth disabled the unwrapped `legacyResolveAuthSms`
        // call in `start.handler.ts` (used to detect the "no SMS provider enabled" warning)
        // becomes the FIRST place `SUPABASE_AUTH_SMS_ENABLE_SIGNUP` gets parsed — a synchronous
        // throw there would surface as an uncaught Effect defect instead. Same shape as the
        // auth.email override regression test above, this override is read before any
        // network/container work starts, so there is nothing yet for rollback to prune — the
        // point of this test is solely that the typed LegacyStartInvalidConfigError surfaces
        // instead of a defect.
        const previous = process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"];
        process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"] = "bad";
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[auth]\nenabled = false\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
          }
          expect(child.spawned).toHaveLength(0);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"];
              else process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails and rolls back when Postgres itself never becomes healthy within its configured health_timeout",
      () => {
        // `db.health_timeout` (unlike the generic 30s `serviceTimeout` every other service
        // waits on) is a real config.toml-configurable seam — this keeps the scenario fast
        // instead of waiting out a real default.
        const neverHealthy = new Set<string>();
        const base = defaultRoute({ neverHealthy });
        const route = (args: ReadonlyArray<string>): RouteResult => {
          if (args[0] === "create") {
            const name = containerNameFromCreateArgs(args);
            if (name.includes("_db_")) neverHealthy.add(name);
          }
          return base(args);
        };
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[db]\nhealth_timeout = "2s"\n',
          route,
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyHealthCheckTimeoutError");
          }
          expect(rollbackWasAttempted(child.spawned)).toBe(true);
          // Postgres's own health wait fails before any other service is ever created.
          expect(createdContainerNames(child.spawned)).toEqual([expect.stringContaining("_db_")]);
        }).pipe(Effect.provide(layer));
      },
      10_000,
    );

    it.live(
      "exits 0 on --ignore-health-check when Postgres itself never becomes healthy, without rolling back and without starting any other service",
      () => {
        // Mirrors the regression test above, but with `--ignore-health-check` set — the
        // `ignoreHealthCheck && legacyIsUnhealthyStartError(err)` downgrade applies
        // uniformly to whatever the run returns, including Postgres's own health-wait
        // failure, which propagates immediately before any
        // other service is even created.
        const neverHealthy = new Set<string>();
        const base = defaultRoute({ neverHealthy });
        const route = (args: ReadonlyArray<string>): RouteResult => {
          if (args[0] === "create") {
            const name = containerNameFromCreateArgs(args);
            if (name.includes("_db_")) neverHealthy.add(name);
          }
          // Postgres's own health wait builds its `images` map separately from the
          // bulk one, so this scripts the marker here too rather than assuming the
          // two call sites are wired the same way.
          if (args[0] === "logs" && (args[1] ?? "").includes("_db_")) {
            return { stdout: ["exec /usr/local/bin/docker-entrypoint.sh: exec format error\n"] };
          }
          return base(args);
        };
        const { layer, out, child, analytics } = setup({
          configContents: 'project_id = "demo"\n[db]\nhealth_timeout = "2s"\n',
          route,
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags({ ignoreHealthCheck: true }));
          expect(out.stderrText).toContain("is not ready");
          expect(out.stderrText).toContain("Started");
          expect(rollbackWasAttempted(child.spawned)).toBe(false);
          // Reported by container name, with the recovery advice naming the image
          // Postgres's own health wait resolved for it.
          expect(out.stderrText).toContain("supabase_db_demo container is not ready");
          expect(out.stderrText).toContain("supabase_db_demo's image");
          expect(out.stderrText).toContain("image rm -f public.ecr.aws/supabase/postgres:");
          // `--ignore-health-check` leaves the stack up, so a bare restart would be a
          // no-op — the sequence must stop first.
          expect(out.stderrText).toContain("supabase stop");
          // No other service's container is ever created — the database bring-up
          // returns before the "Starting containers..." message or any other
          // service's bring-up even begins.
          expect(createdContainerNames(child.spawned)).toEqual([expect.stringContaining("_db_")]);
          // `cli_stack_started` never fires on this fallthrough either — the
          // capture sits after the entire bring-up + bulk health check, neither of
          // which is reached once Postgres's own wait is downgraded to a warning.
          expect(analytics.captured.some((c) => c.event === "cli_stack_started")).toBe(false);
        }).pipe(Effect.provide(layer));
      },
      10_000,
    );

    // Real time, not `it.effect`/`TestClock`: same constraint as the `--ignore-health-check`
    // scenario below — `legacyStart` performs genuine async I/O that never resolves under a
    // virtualized clock. Unlike Postgres's own wait above, this second bulk health check has no
    // config-configurable timeout seam in `start.handler.ts` (`legacyWaitForHealthyServices`
    // is called with no `timeoutSeconds` override, so it falls back to the hardcoded 30s
    // default) — there is no way to shorten this without editing production code, which is out
    // of scope for this task, so this reuses the same generous real-time budget instead.
    it.live(
      "fails and rolls back when a non-Postgres service never becomes healthy within the timeout (no --ignore-health-check)",
      () => {
        const neverHealthy = new Set<string>();
        const route = defaultRoute({ neverHealthy });
        const { layer, out, child } = setup({
          route: (args) => {
            if (args[0] === "create") {
              const name = containerNameFromCreateArgs(args);
              if (name.includes("_auth_")) neverHealthy.add(name);
            }
            return route(args);
          },
          httpClientLayer: unusedHttpClientLayer,
        });

        return Effect.gen(function* () {
          // `edge-runtime` also excluded so its own HTTP readiness probe never
          // reaches `unusedHttpClientLayer` — this scenario is only about the
          // Docker-inspect health path.
          const exit = yield* Effect.exit(
            legacyStart(flags({ exclude: ["postgrest", "edge-runtime"] })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyHealthCheckTimeoutError");
          }
          expect(out.stderrText).not.toContain("Started");
          expect(rollbackWasAttempted(child.spawned)).toBe(true);
        }).pipe(Effect.provide(layer));
      },
      45_000,
    );
  });

  // Real time, not `it.effect`/`TestClock`: `legacyStart` performs genuine
  // async I/O deep inside the forked effect (`legacyResolveLocalJwks`'s
  // `Effect.tryPromise`, `legacyResolveDbImage`'s file read) that needs real
  // Node event-loop turns to settle — under a virtualized `TestClock` those
  // never resolve, so the forked fiber never even reaches the health-check
  // phase. This exercises the real 30s `serviceTimeout` bulk health-check
  // wait (`../../shared/db-bootstrap/health-check.ts`'s default), hence the generous timeout.
  it.live(
    "exits 0 on --ignore-health-check when a non-Postgres container never turns healthy, without rolling back",
    () => {
      // GoTrue's own (post-create) container name is only known once `docker
      // create` reports it — wrap `defaultRoute` to capture it into
      // `neverHealthy` the moment it's created, so every later `container
      // inspect` call on that same id reports "starting", never "healthy".
      const neverHealthy = new Set<string>();
      const route = defaultRoute({ neverHealthy });
      const { layer, out, child, analytics } = setup({
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
        // Sidesteps the PostgREST/Edge Runtime HTTP-HEAD readiness probes
        // entirely, so this scenario only exercises the Docker-inspect health
        // path.
        httpClientLayer: unusedHttpClientLayer,
      });

      return Effect.gen(function* () {
        yield* legacyStart(
          flags({ exclude: ["postgrest", "edge-runtime"], ignoreHealthCheck: true }),
        );
        expect(out.stderrText).toContain("is not ready");
        expect(out.stderrText).toContain("Started");
        expect(rollbackWasAttempted(child.spawned)).toBe(false);
        // Reported by container name, not `docker create`'s opaque id, and the
        // advice names the image actually resolved for that container.
        expect(out.stderrText).toContain("supabase_auth_demo container is not ready");
        expect(out.stderrText).toContain("docker image rm -f public.ecr.aws/supabase/gotrue:");
        // `cli_stack_started` never fires on the ignored-unhealthy
        // fallthrough — only a genuine bulk health-check SUCCESS reaches that capture.
        expect(analytics.captured.some((c) => c.event === "cli_stack_started")).toBe(false);
      }).pipe(Effect.provide(layer));
    },
    45_000,
  );

  describe("--ignore-health-check storage-only recheck and seed on a fresh volume", () => {
    it.live(
      "recheck-and-seeds buckets when storage itself is healthy, then still downgrades the original error to a warning",
      () => {
        const http = mockStorageBucketHttpClient();
        const neverHealthy = new Set<string>();
        const route = freshVolumeRoute(defaultRoute({ neverHealthy }));
        const { layer, out, child, analytics } = setup({
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
        return Effect.gen(function* () {
          yield* legacyStart(
            flags({ exclude: ["postgrest", "edge-runtime"], ignoreHealthCheck: true }),
          );
          expect(http.createdBucketRequests).toHaveLength(1);
          expect(out.stderrText).toContain("is not ready");
          expect(out.stderrText).toContain("Started");
          expect(rollbackWasAttempted(child.spawned)).toBe(false);
          expect(analytics.captured.some((c) => c.event === "cli_stack_started")).toBe(false);
        }).pipe(Effect.provide(layer));
      },
      45_000,
    );

    it.live(
      "a bucket-seed failure during the recheck becomes a hard failure with rollback, replacing the original health error",
      () => {
        // A non-200 bucket-create response fails `legacySeedBucketsRun` deep inside
        // its Storage-gateway call (`LegacyStorageGatewayStatusError`) — unlike an
        // invalid bucket NAME, which `legacyResolveLocalConfigValues`'s own
        // `legacyValidateResolvedConfig` call (step 2 of `legacyStart`, long before
        // any container exists) would already reject before ever reaching Docker.
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
        const { layer, child, analytics } = setup({
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
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            legacyStart(flags({ exclude: ["postgrest", "edge-runtime"], ignoreHealthCheck: true })),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStorageGatewayStatusError");
            // The seed error REPLACES the original health-check timeout entirely.
            expect(serialized).not.toContain("LegacyHealthCheckTimeoutError");
          }
          expect(rollbackWasAttempted(child.spawned)).toBe(true);
          expect(analytics.captured.some((c) => c.event === "cli_stack_started")).toBe(false);
        }).pipe(Effect.provide(layer));
      },
      45_000,
    );

    // Both the main bulk health check (auth) and this storage-only recheck run
    // out their own full ~30s real-time retry budget in this scenario — hence
    // the doubled timeout relative to every other real-time health-check test
    // in this file.
    it.live(
      "falls through to the original warning without attempting to seed when the storage recheck itself never turns healthy",
      () => {
        const neverHealthy = new Set<string>();
        const route = freshVolumeRoute(defaultRoute({ neverHealthy }));
        const http = mockStorageBucketHttpClient();
        const { layer, out, child, analytics } = setup({
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
        return Effect.gen(function* () {
          yield* legacyStart(
            flags({ exclude: ["postgrest", "edge-runtime"], ignoreHealthCheck: true }),
          );
          expect(http.createdBucketRequests).toHaveLength(0);
          expect(out.stderrText).toContain("is not ready");
          expect(out.stderrText).toContain("Started");
          expect(rollbackWasAttempted(child.spawned)).toBe(false);
          expect(analytics.captured.some((c) => c.event === "cli_stack_started")).toBe(false);
        }).pipe(Effect.provide(layer));
      },
      90_000,
    );
  });

  describe("--network-id", () => {
    it.live("overrides the generated network name and every container's --network flag", () => {
      const { layer, child } = setup({ networkId: Option.some("custom-net") });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const networkCreate = child.spawned.find(
          (s) => s.args[0] === "network" && s.args[1] === "create",
        );
        expect(networkCreate?.args.at(-1)).toBe("custom-net");
        const kongCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_kong_"),
        );
        const networkFlagIndex = kongCreate?.args.indexOf("--network") ?? -1;
        expect(kongCreate?.args[networkFlagIndex + 1]).toBe("custom-net");
      }).pipe(Effect.provide(layer));
    });

    it.live("never spawns a create for a pre-created --network-id network", () => {
      const base = defaultRoute();
      const route = (args: ReadonlyArray<string>): RouteResult => {
        if (args[0] === "network" && args[1] === "inspect") return { exitCode: 0 };
        if (args[0] === "network" && args[1] === "create") {
          return { exitCode: 1, stderr: ["error during connect: write: broken pipe"] };
        }
        return base(args);
      };
      const { layer, child } = setup({ networkId: Option.some("custom-net"), route });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        expect(child.spawned.some((s) => s.args[0] === "network" && s.args[1] === "create")).toBe(
          false,
        );
        expect(
          child.spawned.some(
            (s) => s.args[0] === "network" && s.args[1] === "inspect" && s.args[2] === "custom-net",
          ),
        ).toBe(true);
      }).pipe(Effect.provide(layer));
    });

    it.live("falls back to SUPABASE_NETWORK_ID when the flag itself is omitted", () => {
      // `--network-id` falls back to the `SUPABASE_NETWORK_ID` shell/project-dotenv env var
      // ONLY when the flag was never passed (review: PRRT_kwDOErm0O86VlqIL) — see
      // `start.handler.ts`'s own comment on this resolution for the full precedence.
      const previous = process.env["SUPABASE_NETWORK_ID"];
      process.env["SUPABASE_NETWORK_ID"] = "env-net";
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const networkCreate = child.spawned.find(
          (s) => s.args[0] === "network" && s.args[1] === "create",
        );
        expect(networkCreate?.args.at(-1)).toBe("env-net");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_NETWORK_ID"];
            else process.env["SUPABASE_NETWORK_ID"] = previous;
          }),
        ),
      );
    });
  });

  describe("SUPABASE_API_PORT override", () => {
    it.live("publishes Kong on the env-overridden API port, not config.api.port", () => {
      const previous = process.env["SUPABASE_API_PORT"];
      process.env["SUPABASE_API_PORT"] = "61234";
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const kongCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_kong_"),
        );
        expect(kongCreate?.args).toContain("61234:8000");
        expect(kongCreate?.args).not.toContain("54321:8000");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_API_PORT"];
            else process.env["SUPABASE_API_PORT"] = previous;
          }),
        ),
      );
    });
  });

  describe("storage migration pin", () => {
    it.live(
      "threads a linked project's supabase/.temp/storage-migration pin into DB_MIGRATIONS_FREEZE_AT",
      () => {
        const { layer, workdir, child } = setup();
        mkdirSync(join(workdir, "supabase", ".temp"), { recursive: true });
        writeFileSync(join(workdir, "supabase", ".temp", "storage-migration"), "20240102030405\n");
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const storageCreate = child.spawned.find(
            (s) =>
              s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_storage_"),
          );
          expect(storageCreate?.env["DB_MIGRATIONS_FREEZE_AT"]).toBe("20240102030405");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live('resolves to "" when no pin file exists', () => {
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const storageCreate = child.spawned.find(
          (s) =>
            s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_storage_"),
        );
        expect(storageCreate?.env["DB_MIGRATIONS_FREEZE_AT"]).toBe("");
      }).pipe(Effect.provide(layer));
    });
  });

  describe("linked service version pins", () => {
    it.live(
      "resolves a supabase/.temp/storage-version pin into the pulled/created storage image tag",
      () => {
        const { layer, workdir, child } = setup();
        mkdirSync(join(workdir, "supabase", ".temp"), { recursive: true });
        writeFileSync(join(workdir, "supabase", ".temp", "storage-version"), "1.2.3\n");
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const storageImageInspect = child.spawned.find(
            (s) =>
              s.args[0] === "image" &&
              s.args[1] === "inspect" &&
              (s.args[2] ?? "").includes("storage"),
          );
          expect(storageImageInspect?.args[2]).toMatch(/:1\.2\.3$/);
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("db.root_key", () => {
    it.live(
      "delivers a configured db.root_key into the Postgres container's pgsodium root key via `docker cp`, never leaving it on host disk",
      () => {
        const copied = new Map<string, string>();
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[db]\nroot_key = "custom-root-key-value"\n',
          onSecretCopy: (containerPath, content) => {
            copied.set(containerPath, content);
          },
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const containerName = legacyServiceContainerName("db", "demo");
          expect(copied.get("/etc/postgresql-custom/pgsodium_root.key")).toBe(
            "custom-root-key-value",
          );
          const dbCp = child.spawned.find(
            (s) => s.args[0] === "cp" && s.args[2] === `${fakeContainerId(containerName)}:/`,
          );
          expect(dbCp?.args).toEqual(["cp", "-", `${fakeContainerId(containerName)}:/`]);
          expect(dbCp?.args.some((arg) => arg.includes("custom-root-key-value"))).toBe(false);
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("container-not-found stderr shapes", () => {
    it.live(
      "brings up the stack when the DB container's inspect reports 'No such object' instead of 'No such container'",
      () => {
        // Docker/Podman report a missing container as either "No such container" or "No such
        // object" depending on daemon version/CLI path — `legacyIsContainerNotFoundMessage`
        // must recognize both, or `legacyStart`'s "not running, bring up the stack" branch
        // never fires and the inspect failure propagates instead.
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
        const { layer, child } = setup({ route });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const createdNames = createdContainerNames(child.spawned);
          expect(createdNames.some((name) => name.includes("_db_"))).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("Linux host-gateway mapping", () => {
    it.live("adds --add-host host.docker.internal:host-gateway on Linux", () => {
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const kongCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_kong_"),
        );
        const addHostIndex = kongCreate?.args.indexOf("--add-host") ?? -1;
        expect(kongCreate?.args[addHostIndex + 1]).toBe("host.docker.internal:host-gateway");
      }).pipe(Effect.provide(layer));
    });
  });

  describe("auth.email.smtp table-present default", () => {
    it.live(
      "uses the configured SMTP server (not Mailpit) when [auth.email.smtp] omits enabled",
      () => {
        const { layer, child } = setup({
          configContents:
            'project_id = "demo"\n[auth.email.smtp]\nhost = "smtp.example.com"\nport = 587\nuser = "smtp-user"\npass = "smtp-pass"\nadmin_email = "admin@example.com"\n',
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const gotrueCreate = child.spawned.find(
            (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
          );
          expect(gotrueCreate?.env["GOTRUE_SMTP_HOST"]).toBe("smtp.example.com");
          expect(gotrueCreate?.env["GOTRUE_SMTP_PORT"]).toBe("587");
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("custom auth.external providers", () => {
    it.live("emits GOTRUE_EXTERNAL_* env vars for a provider outside the fixed schema set", () => {
      const { layer, child } = setup({
        configContents:
          'project_id = "demo"\n[auth.external.my_oidc]\nenabled = true\nclient_id = "custom-client-id"\nsecret = "custom-secret"\n',
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const gotrueCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
        );
        expect(gotrueCreate?.env["GOTRUE_EXTERNAL_MY_OIDC_ENABLED"]).toBe("true");
        expect(gotrueCreate?.env["GOTRUE_EXTERNAL_MY_OIDC_CLIENT_ID"]).toBe("custom-client-id");
      }).pipe(Effect.provide(layer));
    });
  });

  describe("SUPABASE_LOCAL_SMTP_ADMIN_EMAIL / SUPABASE_LOCAL_SMTP_SENDER_NAME overrides", () => {
    it.live("honors env overrides for the Mailpit fallback's admin email and sender name", () => {
      const previousAdminEmail = process.env["SUPABASE_LOCAL_SMTP_ADMIN_EMAIL"];
      const previousSenderName = process.env["SUPABASE_LOCAL_SMTP_SENDER_NAME"];
      process.env["SUPABASE_LOCAL_SMTP_ADMIN_EMAIL"] = "override-admin@example.com";
      process.env["SUPABASE_LOCAL_SMTP_SENDER_NAME"] = "Override Sender";
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const gotrueCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
        );
        expect(gotrueCreate?.env["GOTRUE_SMTP_ADMIN_EMAIL"]).toBe("override-admin@example.com");
        expect(gotrueCreate?.env["GOTRUE_SMTP_SENDER_NAME"]).toBe("Override Sender");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousAdminEmail === undefined) {
              delete process.env["SUPABASE_LOCAL_SMTP_ADMIN_EMAIL"];
            } else {
              process.env["SUPABASE_LOCAL_SMTP_ADMIN_EMAIL"] = previousAdminEmail;
            }
            if (previousSenderName === undefined) {
              delete process.env["SUPABASE_LOCAL_SMTP_SENDER_NAME"];
            } else {
              process.env["SUPABASE_LOCAL_SMTP_SENDER_NAME"] = previousSenderName;
            }
          }),
        ),
      );
    });
  });

  describe("SUPABASE_LOCAL_SMTP_SMTP_PORT override", () => {
    it.live(
      "fails with a typed config error, before any container is created, on an invalid SUPABASE_LOCAL_SMTP_SMTP_PORT",
      () => {
        const previous = process.env["SUPABASE_LOCAL_SMTP_SMTP_PORT"];
        process.env["SUPABASE_LOCAL_SMTP_SMTP_PORT"] = "not-a-port";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyStartInvalidConfigError");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_LOCAL_SMTP_SMTP_PORT"];
              else process.env["SUPABASE_LOCAL_SMTP_SMTP_PORT"] = previous;
            }),
          ),
        );
      },
    );
  });

  describe("SUPABASE_AUTH_SMS_<PROVIDER>_* overrides", () => {
    it.live(
      "honors env overrides enabling Twilio SMS even when config.toml has it disabled",
      () => {
        const envKeys = [
          "SUPABASE_AUTH_SMS_TWILIO_ENABLED",
          "SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID",
          "SUPABASE_AUTH_SMS_TWILIO_MESSAGE_SERVICE_SID",
          "SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN",
        ] as const;
        const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
        process.env["SUPABASE_AUTH_SMS_TWILIO_ENABLED"] = "true";
        process.env["SUPABASE_AUTH_SMS_TWILIO_ACCOUNT_SID"] = "override-account-sid";
        process.env["SUPABASE_AUTH_SMS_TWILIO_MESSAGE_SERVICE_SID"] =
          "override-message-service-sid";
        process.env["SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN"] = "override-auth-token";
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[auth.sms.twilio]\nenabled = false\n',
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const gotrueCreate = child.spawned.find(
            (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
          );
          expect(gotrueCreate?.env["GOTRUE_SMS_PROVIDER"]).toBe("twilio");
          expect(gotrueCreate?.env["GOTRUE_SMS_TWILIO_ACCOUNT_SID"]).toBe("override-account-sid");
          expect(gotrueCreate?.env["GOTRUE_SMS_TWILIO_MESSAGE_SERVICE_SID"]).toBe(
            "override-message-service-sid",
          );
          expect(gotrueCreate?.env["GOTRUE_SMS_TWILIO_AUTH_TOKEN"]).toBe("override-auth-token");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              for (const key of envKeys) {
                const value = previous[key];
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
              }
            }),
          ),
        );
      },
    );

    it.live(
      "honors SUPABASE_AUTH_SMS_ENABLE_SIGNUP and SUPABASE_AUTH_SMS_MAX_FREQUENCY in GoTrue's env",
      () => {
        const previousEnableSignup = process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"];
        const previousMaxFrequency = process.env["SUPABASE_AUTH_SMS_MAX_FREQUENCY"];
        process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"] = "true";
        process.env["SUPABASE_AUTH_SMS_MAX_FREQUENCY"] = "10s";
        // A complete, enabled provider is required, or SMS validation downgrades
        // enable_signup to false regardless of the override — see the "disables phone login"
        // test below for that behavior itself.
        const { layer, child } = setup({
          configContents:
            'project_id = "demo"\n[auth.sms.twilio]\nenabled = true\naccount_sid = "AC123"\nauth_token = "test-auth-token"\nmessage_service_sid = "MG123"\n',
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const gotrueCreate = child.spawned.find(
            (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
          );
          expect(gotrueCreate?.env["GOTRUE_EXTERNAL_PHONE_ENABLED"]).toBe("true");
          expect(gotrueCreate?.env["GOTRUE_SMS_MAX_FREQUENCY"]).toBe("10s");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previousEnableSignup === undefined) {
                delete process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"];
              } else {
                process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"] = previousEnableSignup;
              }
              if (previousMaxFrequency === undefined) {
                delete process.env["SUPABASE_AUTH_SMS_MAX_FREQUENCY"];
              } else {
                process.env["SUPABASE_AUTH_SMS_MAX_FREQUENCY"] = previousMaxFrequency;
              }
            }),
          ),
        );
      },
    );

    it.live(
      "disables phone login and warns when enable_signup is true with no SMS provider enabled",
      () => {
        // SMS validation downgrades `enable_signup` to `false` (plus a stderr warning) —
        // reached only when every named provider is disabled — before `legacyBuildGotrueEnv`
        // ever reads it.
        const previous = process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"];
        process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"] = "true";
        const { layer, child, out } = setup();
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const gotrueCreate = child.spawned.find(
            (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
          );
          expect(gotrueCreate?.env["GOTRUE_EXTERNAL_PHONE_ENABLED"]).toBe("false");
          expect(out.stderrText).toContain(
            "WARN: no SMS provider is enabled. Disabling phone login",
          );
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"];
              else process.env["SUPABASE_AUTH_SMS_ENABLE_SIGNUP"] = previous;
            }),
          ),
        );
      },
    );
  });

  describe("SUPABASE_AUTH_EMAIL_* overrides", () => {
    it.live(
      "honors SUPABASE_AUTH_EMAIL_ENABLE_SIGNUP and SUPABASE_AUTH_EMAIL_OTP_LENGTH in GoTrue's env",
      () => {
        const previousEnableSignup = process.env["SUPABASE_AUTH_EMAIL_ENABLE_SIGNUP"];
        const previousOtpLength = process.env["SUPABASE_AUTH_EMAIL_OTP_LENGTH"];
        process.env["SUPABASE_AUTH_EMAIL_ENABLE_SIGNUP"] = "false";
        process.env["SUPABASE_AUTH_EMAIL_OTP_LENGTH"] = "8";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const gotrueCreate = child.spawned.find(
            (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
          );
          expect(gotrueCreate?.env["GOTRUE_EXTERNAL_EMAIL_ENABLED"]).toBe("false");
          expect(gotrueCreate?.env["GOTRUE_MAILER_OTP_LENGTH"]).toBe("8");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previousEnableSignup === undefined) {
                delete process.env["SUPABASE_AUTH_EMAIL_ENABLE_SIGNUP"];
              } else {
                process.env["SUPABASE_AUTH_EMAIL_ENABLE_SIGNUP"] = previousEnableSignup;
              }
              if (previousOtpLength === undefined) {
                delete process.env["SUPABASE_AUTH_EMAIL_OTP_LENGTH"];
              } else {
                process.env["SUPABASE_AUTH_EMAIL_OTP_LENGTH"] = previousOtpLength;
              }
            }),
          ),
        );
      },
    );

    it.live(
      "honors SUPABASE_AUTH_EMAIL_TEMPLATE_<NAME>_SUBJECT in GoTrue's mailer subject env",
      () => {
        const previous = process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_CONFIRMATION_SUBJECT"];
        process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_CONFIRMATION_SUBJECT"] = "Override subject";
        const { layer, workdir, child } = setup({
          configContents:
            'project_id = "demo"\n[auth.email.template.confirmation]\ncontent_path = "./templates/confirmation.html"\n',
        });
        mkdirSync(join(workdir, "templates"), { recursive: true });
        writeFileSync(join(workdir, "templates", "confirmation.html"), "<html></html>");
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const gotrueCreate = child.spawned.find(
            (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
          );
          expect(gotrueCreate?.env["GOTRUE_MAILER_SUBJECTS_CONFIRMATION"]).toBe("Override subject");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) {
                delete process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_CONFIRMATION_SUBJECT"];
              } else {
                process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_CONFIRMATION_SUBJECT"] = previous;
              }
            }),
          ),
        );
      },
    );

    it.live(
      "fails fast on SUPABASE_AUTH_EMAIL_TEMPLATE_<NAME>_CONTENT with no content_path configured, matching Go's Config.Validate",
      () => {
        // The env override folds into the email template's content field before
        // validation runs, so it is rejected exactly like a raw TOML `content` key with
        // no `content_path` — before start touches Docker at all.
        const previous = process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_CONFIRMATION_CONTENT"];
        process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_CONFIRMATION_CONTENT"] = "<html>Hi</html>";
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[auth.email.template.confirmation]\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain(
              "Invalid config for auth.email.template.confirmation.content: please use content_path instead",
            );
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) {
                delete process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_CONFIRMATION_CONTENT"];
              } else {
                process.env["SUPABASE_AUTH_EMAIL_TEMPLATE_CONFIRMATION_CONTENT"] = previous;
              }
            }),
          ),
        );
      },
    );
  });

  describe("SUPABASE_DB_PORT override", () => {
    it.live("publishes Postgres on the env-overridden DB port, not config.db.port", () => {
      const previous = process.env["SUPABASE_DB_PORT"];
      process.env["SUPABASE_DB_PORT"] = "54329";
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const dbCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_db_"),
        );
        expect(dbCreate?.args).toContain("54329:5432");
        expect(dbCreate?.args).not.toContain("54322:5432");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_DB_PORT"];
            else process.env["SUPABASE_DB_PORT"] = previous;
          }),
        ),
      );
    });
  });

  describe("SUPABASE_DB_SETTINGS_* env overrides", () => {
    it.live("honors SUPABASE_DB_SETTINGS_SHARED_BUFFERS in the rendered postgresql.conf", () => {
      const previous = process.env["SUPABASE_DB_SETTINGS_SHARED_BUFFERS"];
      process.env["SUPABASE_DB_SETTINGS_SHARED_BUFFERS"] = "256MB";
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const dbCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_db_"),
        );
        expect(dbCreate?.args.some((arg) => arg.includes("shared_buffers = '256MB'"))).toBe(true);
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_DB_SETTINGS_SHARED_BUFFERS"];
            else process.env["SUPABASE_DB_SETTINGS_SHARED_BUFFERS"] = previous;
          }),
        ),
      );
    });
  });

  describe("storage feature env overrides", () => {
    it.live(
      "honors SUPABASE_STORAGE_S3_PROTOCOL_ENABLED and SUPABASE_STORAGE_VECTOR_ENABLED",
      () => {
        const previousS3 = process.env["SUPABASE_STORAGE_S3_PROTOCOL_ENABLED"];
        const previousVector = process.env["SUPABASE_STORAGE_VECTOR_ENABLED"];
        process.env["SUPABASE_STORAGE_S3_PROTOCOL_ENABLED"] = "false";
        process.env["SUPABASE_STORAGE_VECTOR_ENABLED"] = "false";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const storageCreate = child.spawned.find(
            (s) =>
              s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_storage_"),
          );
          expect(storageCreate?.env["S3_PROTOCOL_ENABLED"]).toBe("false");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previousS3 === undefined)
                delete process.env["SUPABASE_STORAGE_S3_PROTOCOL_ENABLED"];
              else process.env["SUPABASE_STORAGE_S3_PROTOCOL_ENABLED"] = previousS3;
              if (previousVector === undefined)
                delete process.env["SUPABASE_STORAGE_VECTOR_ENABLED"];
              else process.env["SUPABASE_STORAGE_VECTOR_ENABLED"] = previousVector;
            }),
          ),
        );
      },
    );
  });

  describe("SUPABASE_ANALYTICS_* env overrides", () => {
    it.live("honors SUPABASE_ANALYTICS_BACKEND/_GCP_* for both Logflare and Studio", () => {
      const previousBackend = process.env["SUPABASE_ANALYTICS_BACKEND"];
      const previousProjectId = process.env["SUPABASE_ANALYTICS_GCP_PROJECT_ID"];
      const previousProjectNumber = process.env["SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER"];
      const previousJwtPath = process.env["SUPABASE_ANALYTICS_GCP_JWT_PATH"];
      process.env["SUPABASE_ANALYTICS_BACKEND"] = "bigquery";
      process.env["SUPABASE_ANALYTICS_GCP_PROJECT_ID"] = "env-gcp-project";
      process.env["SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER"] = "987654321";
      process.env["SUPABASE_ANALYTICS_GCP_JWT_PATH"] = "gcp-key.json";
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const logflareCreate = child.spawned.find(
          (s) =>
            s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_analytics_"),
        );
        expect(logflareCreate?.env["GOOGLE_PROJECT_ID"]).toBe("env-gcp-project");
        expect(logflareCreate?.env["GOOGLE_PROJECT_NUMBER"]).toBe("987654321");
        const studioCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_studio_"),
        );
        expect(studioCreate?.env["NEXT_ANALYTICS_BACKEND_PROVIDER"]).toBe("bigquery");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousBackend === undefined) delete process.env["SUPABASE_ANALYTICS_BACKEND"];
            else process.env["SUPABASE_ANALYTICS_BACKEND"] = previousBackend;
            if (previousProjectId === undefined)
              delete process.env["SUPABASE_ANALYTICS_GCP_PROJECT_ID"];
            else process.env["SUPABASE_ANALYTICS_GCP_PROJECT_ID"] = previousProjectId;
            if (previousProjectNumber === undefined)
              delete process.env["SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER"];
            else process.env["SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER"] = previousProjectNumber;
            if (previousJwtPath === undefined)
              delete process.env["SUPABASE_ANALYTICS_GCP_JWT_PATH"];
            else process.env["SUPABASE_ANALYTICS_GCP_JWT_PATH"] = previousJwtPath;
          }),
        ),
      );
    });
  });

  describe("auth.* env overrides reach GoTrue's container", () => {
    it.live("honors SUPABASE_AUTH_ENABLE_SIGNUP for GOTRUE_DISABLE_SIGNUP", () => {
      const previous = process.env["SUPABASE_AUTH_ENABLE_SIGNUP"];
      process.env["SUPABASE_AUTH_ENABLE_SIGNUP"] = "false";
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const gotrueCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
        );
        expect(gotrueCreate?.env["GOTRUE_DISABLE_SIGNUP"]).toBe("true");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_AUTH_ENABLE_SIGNUP"];
            else process.env["SUPABASE_AUTH_ENABLE_SIGNUP"] = previous;
          }),
        ),
      );
    });
  });

  describe("SUPABASE_EDGE_RUNTIME_DENO_VERSION override", () => {
    it.live("resolves the Deno 1 edge-runtime image tag, not the Deno 2 default", () => {
      const previous = process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"];
      process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = "1";
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const edgeRuntimeImageInspect = child.spawned.find(
          (s) =>
            s.args[0] === "image" &&
            s.args[1] === "inspect" &&
            (s.args[2] ?? "").includes("edge-runtime"),
        );
        expect(edgeRuntimeImageInspect?.args[2]).toBe(
          "public.ecr.aws/supabase/edge-runtime:v1.68.4",
        );
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"];
            else process.env["SUPABASE_EDGE_RUNTIME_DENO_VERSION"] = previous;
          }),
        ),
      );
    });
  });

  describe("SUPABASE_REALTIME_* env overrides", () => {
    it.live(
      "honors SUPABASE_REALTIME_IP_VERSION/_MAX_HEADER_LENGTH for both the long-running container and the PG15+ setup job",
      () => {
        const previousIpVersion = process.env["SUPABASE_REALTIME_IP_VERSION"];
        const previousMaxHeaderLength = process.env["SUPABASE_REALTIME_MAX_HEADER_LENGTH"];
        process.env["SUPABASE_REALTIME_IP_VERSION"] = "IPv6";
        process.env["SUPABASE_REALTIME_MAX_HEADER_LENGTH"] = "8192";
        const { layer, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
        return Effect.gen(function* () {
          yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
          const realtimeCreate = child.spawned.find(
            (s) =>
              s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_realtime_"),
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
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previousIpVersion === undefined)
                delete process.env["SUPABASE_REALTIME_IP_VERSION"];
              else process.env["SUPABASE_REALTIME_IP_VERSION"] = previousIpVersion;
              if (previousMaxHeaderLength === undefined)
                delete process.env["SUPABASE_REALTIME_MAX_HEADER_LENGTH"];
              else process.env["SUPABASE_REALTIME_MAX_HEADER_LENGTH"] = previousMaxHeaderLength;
            }),
          ),
        );
      },
    );

    it.live(
      "fails with a typed config error, before any container is created, on an invalid SUPABASE_REALTIME_IP_VERSION",
      () => {
        const previous = process.env["SUPABASE_REALTIME_IP_VERSION"];
        process.env["SUPABASE_REALTIME_IP_VERSION"] = "IPv5";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyStartInvalidConfigError");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_REALTIME_IP_VERSION"];
              else process.env["SUPABASE_REALTIME_IP_VERSION"] = previous;
            }),
          ),
        );
      },
    );
  });

  describe("Studio API URL normalization", () => {
    it.live(
      "rewrites the default studio.api_url to the Kong URL rather than passing it through raw",
      () => {
        const { layer, child } = setup();
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const studioCreate = child.spawned.find(
            (s) =>
              s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_studio_"),
          );
          expect(studioCreate?.env["SUPABASE_PUBLIC_URL"]).toBe("http://127.0.0.1:54321");
          expect(studioCreate?.env["SUPABASE_PUBLIC_URL"]).not.toBe("http://127.0.0.1");
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("SUPABASE_STORAGE_FILE_SIZE_LIMIT override", () => {
    it.live(
      "honors the override for both Storage's container and the fresh-volume migrate job",
      () => {
        const previous = process.env["SUPABASE_STORAGE_FILE_SIZE_LIMIT"];
        process.env["SUPABASE_STORAGE_FILE_SIZE_LIMIT"] = "5MiB";
        const { layer, child } = setup({ route: freshVolumeRoute(defaultRoute()) });
        return Effect.gen(function* () {
          yield* legacyStart(flags({ exclude: ["edge-runtime"] }));
          const storageCreate = child.spawned.find(
            (s) =>
              s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_storage_"),
          );
          expect(storageCreate?.env["FILE_SIZE_LIMIT"]).toBe(String(5 * 1024 * 1024));

          // Second of the three PG15+ one-shot migrate jobs (realtime, storage, auth order).
          const migrateJobs = child.spawned.filter(
            (s) => s.args[0] === "run" && s.args[1] === "--rm",
          );
          expect(migrateJobs[1]?.env["FILE_SIZE_LIMIT"]).toBe(String(5 * 1024 * 1024));
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_STORAGE_FILE_SIZE_LIMIT"];
              else process.env["SUPABASE_STORAGE_FILE_SIZE_LIMIT"] = previous;
            }),
          ),
        );
      },
    );
  });

  describe("SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION override", () => {
    it.live(
      "selects the OrioleDB Postgres image and enables the container's S3 env when set only via env",
      () => {
        const previous = process.env["SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION"];
        process.env["SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION"] = "16.0.0.1";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const dbImageInspect = child.spawned.find(
            (s) =>
              s.args[0] === "image" &&
              s.args[1] === "inspect" &&
              (s.args[2] ?? "").includes("postgres"),
          );
          expect(dbImageInspect?.args[2]).toContain("16.0.0.1-orioledb");

          const dbCreate = child.spawned.find(
            (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_db_"),
          );
          expect(dbCreate?.env["S3_ENABLED"]).toBe("true");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined)
                delete process.env["SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION"];
              else process.env["SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION"] = previous;
            }),
          ),
        );
      },
    );

    it.live("honors SUPABASE_EXPERIMENTAL_S3_HOST/_REGION/_ACCESS_KEY/_SECRET_KEY", () => {
      const previousVersion = process.env["SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION"];
      const previousHost = process.env["SUPABASE_EXPERIMENTAL_S3_HOST"];
      const previousRegion = process.env["SUPABASE_EXPERIMENTAL_S3_REGION"];
      const previousAccessKey = process.env["SUPABASE_EXPERIMENTAL_S3_ACCESS_KEY"];
      const previousSecretKey = process.env["SUPABASE_EXPERIMENTAL_S3_SECRET_KEY"];
      process.env["SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION"] = "16.0.0.1";
      process.env["SUPABASE_EXPERIMENTAL_S3_HOST"] = "env-s3-host";
      process.env["SUPABASE_EXPERIMENTAL_S3_REGION"] = "env-s3-region";
      process.env["SUPABASE_EXPERIMENTAL_S3_ACCESS_KEY"] = "env-s3-access-key";
      process.env["SUPABASE_EXPERIMENTAL_S3_SECRET_KEY"] = "env-s3-secret-key";
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const dbCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_db_"),
        );
        expect(dbCreate?.env["S3_HOST"]).toBe("env-s3-host");
        expect(dbCreate?.env["S3_REGION"]).toBe("env-s3-region");
        expect(dbCreate?.env["S3_ACCESS_KEY"]).toBe("env-s3-access-key");
        expect(dbCreate?.env["S3_SECRET_KEY"]).toBe("env-s3-secret-key");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousVersion === undefined)
              delete process.env["SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION"];
            else process.env["SUPABASE_EXPERIMENTAL_ORIOLEDB_VERSION"] = previousVersion;
            if (previousHost === undefined) delete process.env["SUPABASE_EXPERIMENTAL_S3_HOST"];
            else process.env["SUPABASE_EXPERIMENTAL_S3_HOST"] = previousHost;
            if (previousRegion === undefined) delete process.env["SUPABASE_EXPERIMENTAL_S3_REGION"];
            else process.env["SUPABASE_EXPERIMENTAL_S3_REGION"] = previousRegion;
            if (previousAccessKey === undefined)
              delete process.env["SUPABASE_EXPERIMENTAL_S3_ACCESS_KEY"];
            else process.env["SUPABASE_EXPERIMENTAL_S3_ACCESS_KEY"] = previousAccessKey;
            if (previousSecretKey === undefined)
              delete process.env["SUPABASE_EXPERIMENTAL_S3_SECRET_KEY"];
            else process.env["SUPABASE_EXPERIMENTAL_S3_SECRET_KEY"] = previousSecretKey;
          }),
        ),
      );
    });
  });

  describe("Kong's embedded default TLS cert/key", () => {
    it.live(
      "writes the embedded default cert/key when TLS is unconfigured, never empty files",
      () => {
        const copied = new Map<string, string>();
        const { layer, child } = setup({
          onSecretCopy: (containerPath, content) => {
            copied.set(containerPath, content);
          },
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(true);
          expect(copied.get("/home/kong/localhost.crt")).toBe(LEGACY_KONG_LOCAL_TLS_CERT);
          expect(copied.get("/home/kong/localhost.key")).toBe(LEGACY_KONG_LOCAL_TLS_KEY);
        }).pipe(Effect.provide(layer));
      },
    );

    // An empty but present `cert_path`/`key_path` is treated the same as
    // absent — it must NOT attempt a disk read.
    it.live(
      "falls back to the embedded default cert/key when cert_path/key_path are present but empty",
      () => {
        const copied = new Map<string, string>();
        const { layer, child } = setup({
          configContents:
            'project_id = "demo"\n[api.tls]\nenabled = true\ncert_path = ""\nkey_path = ""\n',
          onSecretCopy: (containerPath, content) => {
            copied.set(containerPath, content);
          },
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(true);
          expect(copied.get("/home/kong/localhost.crt")).toBe(LEGACY_KONG_LOCAL_TLS_CERT);
          expect(copied.get("/home/kong/localhost.key")).toBe(LEGACY_KONG_LOCAL_TLS_KEY);
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("SUPABASE_API_TLS_CERT_PATH/_KEY_PATH overrides", () => {
    it.live(
      "reads the env-overridden cert/key paths for Kong, not the (absent) TOML fields",
      () => {
        const previousCert = process.env["SUPABASE_API_TLS_CERT_PATH"];
        const previousKey = process.env["SUPABASE_API_TLS_KEY_PATH"];
        const copied = new Map<string, string>();
        const { layer, workdir, child } = setup({
          configContents: 'project_id = "demo"\n[api.tls]\nenabled = true\n',
          onSecretCopy: (containerPath, content) => {
            copied.set(containerPath, content);
          },
        });
        mkdirSync(join(workdir, "supabase", "certs"), { recursive: true });
        writeFileSync(
          join(workdir, "supabase", "certs", "env-server.crt"),
          "-----BEGIN CERTIFICATE-----env-cert",
        );
        writeFileSync(
          join(workdir, "supabase", "certs", "env-server.key"),
          "-----BEGIN PRIVATE KEY-----env-key",
        );
        process.env["SUPABASE_API_TLS_CERT_PATH"] = "certs/env-server.crt";
        process.env["SUPABASE_API_TLS_KEY_PATH"] = "certs/env-server.key";
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(true);
          expect(copied.get("/home/kong/localhost.crt")).toBe(
            "-----BEGIN CERTIFICATE-----env-cert",
          );
          expect(copied.get("/home/kong/localhost.key")).toBe("-----BEGIN PRIVATE KEY-----env-key");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previousCert === undefined) delete process.env["SUPABASE_API_TLS_CERT_PATH"];
              else process.env["SUPABASE_API_TLS_CERT_PATH"] = previousCert;
              if (previousKey === undefined) delete process.env["SUPABASE_API_TLS_KEY_PATH"];
              else process.env["SUPABASE_API_TLS_KEY_PATH"] = previousKey;
            }),
          ),
        );
      },
    );
  });

  describe("SUPABASE_API_ENABLED override", () => {
    // The entire TLS cert/key disk read is nested inside the API-enabled check —
    // when API is disabled (however that happened), Kong
    // keeps its embedded default cert/key regardless of `api.tls.enabled`/cert_path/key_path.
    it.live(
      "skips the configured cert/key read for Kong when API is disabled only via env override",
      () => {
        const previous = process.env["SUPABASE_API_ENABLED"];
        process.env["SUPABASE_API_ENABLED"] = "false";
        const copied = new Map<string, string>();
        const { layer, workdir, child } = setup({
          configContents: 'project_id = "demo"\n[api.tls]\nenabled = true\n',
          onSecretCopy: (containerPath, content) => {
            copied.set(containerPath, content);
          },
        });
        mkdirSync(join(workdir, "supabase", "certs"), { recursive: true });
        writeFileSync(
          join(workdir, "supabase", "certs", "server.crt"),
          "-----BEGIN CERTIFICATE-----custom-cert",
        );
        writeFileSync(
          join(workdir, "supabase", "certs", "server.key"),
          "-----BEGIN PRIVATE KEY-----custom-key",
        );
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(true);
          expect(copied.get("/home/kong/localhost.crt")).toBe(LEGACY_KONG_LOCAL_TLS_CERT);
          expect(copied.get("/home/kong/localhost.key")).toBe(LEGACY_KONG_LOCAL_TLS_KEY);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_API_ENABLED"];
              else process.env["SUPABASE_API_ENABLED"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails with a typed config error, before any container is created, on an invalid SUPABASE_API_ENABLED",
      () => {
        const previous = process.env["SUPABASE_API_ENABLED"];
        process.env["SUPABASE_API_ENABLED"] = "not-a-bool";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyStartInvalidConfigError");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_API_ENABLED"];
              else process.env["SUPABASE_API_ENABLED"] = previous;
            }),
          ),
        );
      },
    );
  });

  describe("SUPABASE_AUTH_JWT_EXPIRY reaches Postgres init", () => {
    it.live("honors the override for Postgres's JWT_EXP, not just GoTrue's GOTRUE_JWT_EXP", () => {
      const previous = process.env["SUPABASE_AUTH_JWT_EXPIRY"];
      process.env["SUPABASE_AUTH_JWT_EXPIRY"] = "7200";
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const dbCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_db_"),
        );
        expect(dbCreate?.env["JWT_EXP"]).toBe("7200");
        const gotrueCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
        );
        expect(gotrueCreate?.env["GOTRUE_JWT_EXP"]).toBe("7200");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_AUTH_JWT_EXPIRY"];
            else process.env["SUPABASE_AUTH_JWT_EXPIRY"] = previous;
          }),
        ),
      );
    });
  });

  describe("encrypted secrets reach GoTrue's container", () => {
    it.live("decrypts an encrypted external OAuth provider secret (known provider)", () => {
      const previous = process.env["DOTENV_PRIVATE_KEY"];
      process.env["DOTENV_PRIVATE_KEY"] = VAULT_PRIVATE_KEY;
      const { layer, child } = setup({
        configContents: `project_id = "demo"\n[auth.external.github]\nenabled = true\nclient_id = "gh-client-id"\nsecret = "${VAULT_ENCRYPTED}"\n`,
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const gotrueCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
        );
        expect(gotrueCreate?.env["GOTRUE_EXTERNAL_GITHUB_SECRET"]).toBe("value");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["DOTENV_PRIVATE_KEY"];
            else process.env["DOTENV_PRIVATE_KEY"] = previous;
          }),
        ),
      );
    });

    it.live(
      "decrypts an encrypted external OAuth provider secret (custom/unmodeled provider)",
      () => {
        const previous = process.env["DOTENV_PRIVATE_KEY"];
        process.env["DOTENV_PRIVATE_KEY"] = VAULT_PRIVATE_KEY;
        const { layer, child } = setup({
          configContents: `project_id = "demo"\n[auth.external.my_oidc]\nenabled = true\nclient_id = "custom-client-id"\nsecret = "${VAULT_ENCRYPTED}"\n`,
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const gotrueCreate = child.spawned.find(
            (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
          );
          expect(gotrueCreate?.env["GOTRUE_EXTERNAL_MY_OIDC_SECRET"]).toBe("value");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["DOTENV_PRIVATE_KEY"];
              else process.env["DOTENV_PRIVATE_KEY"] = previous;
            }),
          ),
        );
      },
    );

    it.live("decrypts an encrypted Twilio SMS auth_token", () => {
      const previous = process.env["DOTENV_PRIVATE_KEY"];
      process.env["DOTENV_PRIVATE_KEY"] = VAULT_PRIVATE_KEY;
      const { layer, child } = setup({
        configContents: `project_id = "demo"\n[auth.sms.twilio]\nenabled = true\naccount_sid = "AC123"\nauth_token = "${VAULT_ENCRYPTED}"\nmessage_service_sid = "MG123"\n`,
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const gotrueCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
        );
        expect(gotrueCreate?.env["GOTRUE_SMS_TWILIO_AUTH_TOKEN"]).toBe("value");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["DOTENV_PRIVATE_KEY"];
            else process.env["DOTENV_PRIVATE_KEY"] = previous;
          }),
        ),
      );
    });
  });

  describe("Edge Runtime secrets", () => {
    it.live(
      "resolves configured [edge_runtime.secrets] into the runtime's env, not dropped",
      () => {
        const { layer, child } = setup({
          configContents:
            'project_id = "demo"\n[edge_runtime.secrets]\nMY_SECRET = "shh-do-not-tell"\nmy_lower_secret = "keep-me"\nEMPTY_SECRET = ""\n',
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const edgeRuntimeRunCall = child.spawned.find((s) => isEdgeRuntimeCreate(s.args));
          const args = edgeRuntimeRunCall?.args ?? [];
          const envFileIndex = args.indexOf("--env-file");
          const envFilePath = envFileIndex !== -1 ? args[envFileIndex + 1] : undefined;
          expect(envFilePath).toBeDefined();
          const envFileContent = readFileSync(envFilePath ?? "", "utf-8");
          expect(envFileContent).toContain("MY_SECRET=shh-do-not-tell");
          // Names reach the container UPPERCASED — every secret key is uppercased
          // — and empty values are skipped, shared with
          // `functions serve` via `toPlainEdgeRuntimeConfig`.
          expect(envFileContent).toContain("MY_LOWER_SECRET=keep-me");
          expect(envFileContent).not.toContain("my_lower_secret=");
          expect(envFileContent).not.toContain("EMPTY_SECRET=");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "decrypts an encrypted [edge_runtime.secrets] entry into plaintext, not the raw ciphertext",
      () => {
        // Mirrors "encrypted secrets reach GoTrue's container" above, but for
        // `edge_runtime.secrets` — this field decrypts during config load too, so the real
        // Edge Runtime container's env file must contain the decrypted "value", never the
        // literal `encrypted:...` string.
        const previous = process.env["DOTENV_PRIVATE_KEY"];
        process.env["DOTENV_PRIVATE_KEY"] = VAULT_PRIVATE_KEY;
        const { layer, child } = setup({
          configContents: `project_id = "demo"\n[edge_runtime.secrets]\nMY_SECRET = "${VAULT_ENCRYPTED}"\n`,
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const edgeRuntimeRunCall = child.spawned.find((s) => isEdgeRuntimeCreate(s.args));
          const args = edgeRuntimeRunCall?.args ?? [];
          const envFileIndex = args.indexOf("--env-file");
          const envFilePath = envFileIndex !== -1 ? args[envFileIndex + 1] : undefined;
          expect(envFilePath).toBeDefined();
          const envFileContent = readFileSync(envFilePath ?? "", "utf-8");
          expect(envFileContent).toContain("MY_SECRET=value");
          expect(envFileContent).not.toContain("encrypted:");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["DOTENV_PRIVATE_KEY"];
              else process.env["DOTENV_PRIVATE_KEY"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails with a typed config error, before any container is created, on an undecryptable [edge_runtime.secrets] entry",
      () => {
        // Caught eagerly by `legacyCheckDbToml`'s `legacyAssertDecryptableSecrets` pre-check
        // (`edge_runtime.secrets.*` is one of `LEGACY_SECRET_PATHS`), well before the bring-up
        // loop's own edge-runtime-specific decrypt — same shape as the sibling `[db.vault]`
        // "even on a non-fresh volume" test above.
        const previous = process.env["DOTENV_PRIVATE_KEY"];
        delete process.env["DOTENV_PRIVATE_KEY"];
        const { layer, child } = setup({
          configContents: `project_id = "demo"\n[edge_runtime.secrets]\nMY_SECRET = "${VAULT_ENCRYPTED}"\n`,
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyDbConfigLoadError");
            expect(serialized).toContain("failed to parse config: missing private key");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["DOTENV_PRIVATE_KEY"];
              else process.env["DOTENV_PRIVATE_KEY"] = previous;
            }),
          ),
        );
      },
    );
  });

  describe("SUPABASE_API_* env overrides reach PostgREST and Studio", () => {
    it.live("honors SUPABASE_API_SCHEMAS/_EXTRA_SEARCH_PATH/_MAX_ROWS in both containers", () => {
      const previousSchemas = process.env["SUPABASE_API_SCHEMAS"];
      const previousSearchPath = process.env["SUPABASE_API_EXTRA_SEARCH_PATH"];
      const previousMaxRows = process.env["SUPABASE_API_MAX_ROWS"];
      process.env["SUPABASE_API_SCHEMAS"] = "public,custom";
      process.env["SUPABASE_API_EXTRA_SEARCH_PATH"] = "extensions,other";
      process.env["SUPABASE_API_MAX_ROWS"] = "500";
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const restCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_rest_"),
        );
        expect(restCreate?.env["PGRST_DB_SCHEMAS"]).toBe("public,custom");
        expect(restCreate?.env["PGRST_DB_EXTRA_SEARCH_PATH"]).toBe("extensions,other");
        expect(restCreate?.env["PGRST_DB_MAX_ROWS"]).toBe("500");
        const studioCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_studio_"),
        );
        expect(studioCreate?.env["PGRST_DB_SCHEMAS"]).toBe("public,custom");
        expect(studioCreate?.env["PGRST_DB_EXTRA_SEARCH_PATH"]).toBe("extensions,other");
        expect(studioCreate?.env["PGRST_DB_MAX_ROWS"]).toBe("500");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousSchemas === undefined) delete process.env["SUPABASE_API_SCHEMAS"];
            else process.env["SUPABASE_API_SCHEMAS"] = previousSchemas;
            if (previousSearchPath === undefined)
              delete process.env["SUPABASE_API_EXTRA_SEARCH_PATH"];
            else process.env["SUPABASE_API_EXTRA_SEARCH_PATH"] = previousSearchPath;
            if (previousMaxRows === undefined) delete process.env["SUPABASE_API_MAX_ROWS"];
            else process.env["SUPABASE_API_MAX_ROWS"] = previousMaxRows;
          }),
        ),
      );
    });

    it.live(
      "fails with a typed config error, before any container is created, on an invalid SUPABASE_API_MAX_ROWS",
      () => {
        const previous = process.env["SUPABASE_API_MAX_ROWS"];
        process.env["SUPABASE_API_MAX_ROWS"] = "not-a-number";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyStartInvalidConfigError");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_API_MAX_ROWS"];
              else process.env["SUPABASE_API_MAX_ROWS"] = previous;
            }),
          ),
        );
      },
    );
  });

  describe("SUPABASE_DB_POOLER_* env overrides reach Supavisor", () => {
    it.live("SUPABASE_DB_POOLER_POOL_MODE=session flips the published host port to 5432", () => {
      const previous = process.env["SUPABASE_DB_POOLER_POOL_MODE"];
      process.env["SUPABASE_DB_POOLER_POOL_MODE"] = "session";
      const { layer, child } = setup({
        configContents: 'project_id = "demo"\n[db.pooler]\nenabled = true\n',
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const poolerCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_pooler_"),
        );
        // `db.pooler.port` defaults to 54329 (`packages/config/src/db.ts`) —
        // the published `-p <hostPort>:<containerPort>` mapping is what
        // changes with pool mode; the exposed-ports list always lists both
        // 5432 and 6543 regardless, so assert on the specific mapping string.
        expect(poolerCreate?.args).toContain("54329:5432");
        expect(poolerCreate?.args).not.toContain("54329:6543");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_DB_POOLER_POOL_MODE"];
            else process.env["SUPABASE_DB_POOLER_POOL_MODE"] = previous;
          }),
        ),
      );
    });

    it.live(
      "fails with a typed config error, before any container is created, on an invalid SUPABASE_DB_POOLER_POOL_MODE",
      () => {
        const previous = process.env["SUPABASE_DB_POOLER_POOL_MODE"];
        process.env["SUPABASE_DB_POOLER_POOL_MODE"] = "bogus";
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[db.pooler]\nenabled = true\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyStartInvalidConfigError");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_DB_POOLER_POOL_MODE"];
              else process.env["SUPABASE_DB_POOLER_POOL_MODE"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "fails with a typed config error, before any container is created, on an invalid SUPABASE_REALTIME_ENABLED",
      () => {
        const previous = process.env["SUPABASE_REALTIME_ENABLED"];
        process.env["SUPABASE_REALTIME_ENABLED"] = "maybe";
        const { layer, child } = setup({ configContents: 'project_id = "demo"\n' });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyStartInvalidConfigError");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_REALTIME_ENABLED"];
              else process.env["SUPABASE_REALTIME_ENABLED"] = previous;
            }),
          ),
        );
      },
    );

    it.live("SUPABASE_DB_POOLER_PORT overrides the published host port", () => {
      const previous = process.env["SUPABASE_DB_POOLER_PORT"];
      process.env["SUPABASE_DB_POOLER_PORT"] = "60001";
      const { layer, child } = setup({
        configContents: 'project_id = "demo"\n[db.pooler]\nenabled = true\n',
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const poolerCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_pooler_"),
        );
        // Default pool_mode ("transaction") publishes the pooler port against
        // container port 6543 — see the SUPABASE_DB_POOLER_POOL_MODE test above.
        expect(poolerCreate?.args).toContain("60001:6543");
        expect(poolerCreate?.args).not.toContain("54329:6543");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_DB_POOLER_PORT"];
            else process.env["SUPABASE_DB_POOLER_PORT"] = previous;
          }),
        ),
      );
    });
  });

  describe("SUPABASE_ANALYTICS_PORT override", () => {
    it.live("overrides the published Logflare host port", () => {
      const previous = process.env["SUPABASE_ANALYTICS_PORT"];
      process.env["SUPABASE_ANALYTICS_PORT"] = "60002";
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const logflareCreate = child.spawned.find(
          (s) =>
            s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_analytics_"),
        );
        expect(logflareCreate?.args).toContain("60002:4000");
        expect(logflareCreate?.args).not.toContain("54327:4000");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_ANALYTICS_PORT"];
            else process.env["SUPABASE_ANALYTICS_PORT"] = previous;
          }),
        ),
      );
    });

    it.live(
      "fails with a typed config error, before any container is created, on an invalid SUPABASE_ANALYTICS_VECTOR_PORT",
      () => {
        // `analytics.vector_port` (Logflare's deprecated Vector port) is decoded in the same
        // Config.Load pass as `analytics.port` above — nothing downstream in `start` reads the
        // resolved value, but a malformed override must still fail eagerly, same reasoning as
        // the SUPABASE_LOCAL_SMTP_SMTP_PORT/SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT tests elsewhere
        // in this file.
        const previous = process.env["SUPABASE_ANALYTICS_VECTOR_PORT"];
        process.env["SUPABASE_ANALYTICS_VECTOR_PORT"] = "not-a-port";
        const { layer, child } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for analytics.vector_port");
          }
          expect(child.spawned.some((s) => s.args[0] === "create")).toBe(false);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_ANALYTICS_VECTOR_PORT"];
              else process.env["SUPABASE_ANALYTICS_VECTOR_PORT"] = previous;
            }),
          ),
        );
      },
    );
  });

  describe("SUPABASE_DB_HEALTH_TIMEOUT override", () => {
    it.live(
      "honors an env-overridden health_timeout, not just the config.toml/default value",
      () => {
        const previous = process.env["SUPABASE_DB_HEALTH_TIMEOUT"];
        process.env["SUPABASE_DB_HEALTH_TIMEOUT"] = "2s";
        const neverHealthy = new Set<string>();
        const base = defaultRoute({ neverHealthy });
        const route = (args: ReadonlyArray<string>): RouteResult => {
          if (args[0] === "create") {
            const name = containerNameFromCreateArgs(args);
            if (name.includes("_db_")) neverHealthy.add(name);
          }
          return base(args);
        };
        const { layer, child } = setup({ route });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyHealthCheckTimeoutError");
          }
          // Postgres's own health wait fails before any other service is ever created —
          // proving the short env-overridden timeout took effect (the default is much longer).
          expect(createdContainerNames(child.spawned)).toEqual([expect.stringContaining("_db_")]);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["SUPABASE_DB_HEALTH_TIMEOUT"];
              else process.env["SUPABASE_DB_HEALTH_TIMEOUT"] = previous;
            }),
          ),
        );
      },
      10_000,
    );
  });

  describe("auth.hook.* env overrides reach GoTrue's container", () => {
    it.live("honors SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED/_URI", () => {
      const previousEnabled = process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED"];
      const previousUri = process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI"];
      process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED"] = "true";
      // A pg-functions URI needs no `secrets` (unlike http/https, validated by
      // `legacyValidateResolvedConfig`), keeping this scenario focused on the
      // enabled/uri override reaching GoTrue.
      process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI"] =
        "pg-functions://postgres/auth/custom-access-token-hook";
      const { layer, child } = setup({
        configContents: 'project_id = "demo"\n[auth.hook.custom_access_token]\nenabled = false\n',
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const gotrueCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
        );
        expect(gotrueCreate?.env["GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED"]).toBe("true");
        expect(gotrueCreate?.env["GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI"]).toBe(
          "pg-functions://postgres/auth/custom-access-token-hook",
        );
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousEnabled === undefined)
              delete process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED"];
            else process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED"] = previousEnabled;
            if (previousUri === undefined)
              delete process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI"];
            else process.env["SUPABASE_AUTH_HOOK_CUSTOM_ACCESS_TOKEN_URI"] = previousUri;
          }),
        ),
      );
    });
  });

  describe("auth.captcha.* env overrides reach GoTrue's container", () => {
    it.live("honors SUPABASE_AUTH_CAPTCHA_ENABLED/_PROVIDER", () => {
      const previousEnabled = process.env["SUPABASE_AUTH_CAPTCHA_ENABLED"];
      const previousProvider = process.env["SUPABASE_AUTH_CAPTCHA_PROVIDER"];
      process.env["SUPABASE_AUTH_CAPTCHA_ENABLED"] = "true";
      process.env["SUPABASE_AUTH_CAPTCHA_PROVIDER"] = "turnstile";
      const { layer, child } = setup({
        configContents:
          'project_id = "demo"\n[auth.captcha]\nenabled = false\nprovider = "hcaptcha"\nsecret = "test-secret"\n',
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const gotrueCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
        );
        expect(gotrueCreate?.env["GOTRUE_SECURITY_CAPTCHA_ENABLED"]).toBe("true");
        expect(gotrueCreate?.env["GOTRUE_SECURITY_CAPTCHA_PROVIDER"]).toBe("turnstile");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousEnabled === undefined) delete process.env["SUPABASE_AUTH_CAPTCHA_ENABLED"];
            else process.env["SUPABASE_AUTH_CAPTCHA_ENABLED"] = previousEnabled;
            if (previousProvider === undefined)
              delete process.env["SUPABASE_AUTH_CAPTCHA_PROVIDER"];
            else process.env["SUPABASE_AUTH_CAPTCHA_PROVIDER"] = previousProvider;
          }),
        ),
      );
    });
  });

  describe("nested auth security env overrides reach GoTrue's container", () => {
    it.live("honors SUPABASE_AUTH_SESSIONS_TIMEBOX", () => {
      const previous = process.env["SUPABASE_AUTH_SESSIONS_TIMEBOX"];
      process.env["SUPABASE_AUTH_SESSIONS_TIMEBOX"] = "24h";
      const { layer, child } = setup({ configContents: 'project_id = "demo"\n' });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const gotrueCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
        );
        expect(gotrueCreate?.env["GOTRUE_SESSIONS_TIMEBOX"]).toBe("24h0m0s");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_AUTH_SESSIONS_TIMEBOX"];
            else process.env["SUPABASE_AUTH_SESSIONS_TIMEBOX"] = previous;
          }),
        ),
      );
    });

    it.live("honors SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED/_VERIFY_ENABLED", () => {
      const previousEnroll = process.env["SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED"];
      const previousVerify = process.env["SUPABASE_AUTH_MFA_TOTP_VERIFY_ENABLED"];
      process.env["SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED"] = "true";
      process.env["SUPABASE_AUTH_MFA_TOTP_VERIFY_ENABLED"] = "true";
      const { layer, child } = setup({
        configContents: 'project_id = "demo"\n[auth.mfa.totp]\nenroll_enabled = false\n',
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const gotrueCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
        );
        expect(gotrueCreate?.env["GOTRUE_MFA_TOTP_ENROLL_ENABLED"]).toBe("true");
        expect(gotrueCreate?.env["GOTRUE_MFA_TOTP_VERIFY_ENABLED"]).toBe("true");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousEnroll === undefined)
              delete process.env["SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED"];
            else process.env["SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED"] = previousEnroll;
            if (previousVerify === undefined)
              delete process.env["SUPABASE_AUTH_MFA_TOTP_VERIFY_ENABLED"];
            else process.env["SUPABASE_AUTH_MFA_TOTP_VERIFY_ENABLED"] = previousVerify;
          }),
        ),
      );
    });

    it.live("honors SUPABASE_AUTH_RATE_LIMIT_SMS_SENT", () => {
      const previous = process.env["SUPABASE_AUTH_RATE_LIMIT_SMS_SENT"];
      process.env["SUPABASE_AUTH_RATE_LIMIT_SMS_SENT"] = "99";
      const { layer, child } = setup({ configContents: 'project_id = "demo"\n' });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const gotrueCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
        );
        expect(gotrueCreate?.env["GOTRUE_RATE_LIMIT_SMS_SENT"]).toBe("99");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_AUTH_RATE_LIMIT_SMS_SENT"];
            else process.env["SUPABASE_AUTH_RATE_LIMIT_SMS_SENT"] = previous;
          }),
        ),
      );
    });

    it.live("honors SUPABASE_AUTH_WEB3_SOLANA_ENABLED", () => {
      const previous = process.env["SUPABASE_AUTH_WEB3_SOLANA_ENABLED"];
      process.env["SUPABASE_AUTH_WEB3_SOLANA_ENABLED"] = "true";
      const { layer, child } = setup({ configContents: 'project_id = "demo"\n' });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const gotrueCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
        );
        expect(gotrueCreate?.env["GOTRUE_EXTERNAL_WEB3_SOLANA_ENABLED"]).toBe("true");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_AUTH_WEB3_SOLANA_ENABLED"];
            else process.env["SUPABASE_AUTH_WEB3_SOLANA_ENABLED"] = previous;
          }),
        ),
      );
    });

    it.live("honors SUPABASE_AUTH_OAUTH_SERVER_ENABLED", () => {
      const previous = process.env["SUPABASE_AUTH_OAUTH_SERVER_ENABLED"];
      process.env["SUPABASE_AUTH_OAUTH_SERVER_ENABLED"] = "true";
      const { layer, child } = setup({ configContents: 'project_id = "demo"\n' });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const gotrueCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
        );
        expect(gotrueCreate?.env["GOTRUE_OAUTH_SERVER_ENABLED"]).toBe("true");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_AUTH_OAUTH_SERVER_ENABLED"];
            else process.env["SUPABASE_AUTH_OAUTH_SERVER_ENABLED"] = previous;
          }),
        ),
      );
    });
  });

  describe("auth.passkey/auth.webauthn env overrides reach GoTrue's container", () => {
    it.live("honors SUPABASE_AUTH_PASSKEY_ENABLED", () => {
      const previous = process.env["SUPABASE_AUTH_PASSKEY_ENABLED"];
      process.env["SUPABASE_AUTH_PASSKEY_ENABLED"] = "true";
      const { layer, child } = setup({
        configContents:
          'project_id = "demo"\n[auth.passkey]\nenabled = false\n[auth.webauthn]\nrp_id = "localhost"\nrp_origins = ["http://localhost:3000"]\n',
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const gotrueCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
        );
        expect(gotrueCreate?.env["GOTRUE_PASSKEY_ENABLED"]).toBe("true");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_AUTH_PASSKEY_ENABLED"];
            else process.env["SUPABASE_AUTH_PASSKEY_ENABLED"] = previous;
          }),
        ),
      );
    });

    it.live("honors SUPABASE_AUTH_WEBAUTHN_RP_ID/_RP_DISPLAY_NAME/_RP_ORIGINS", () => {
      const previousRpId = process.env["SUPABASE_AUTH_WEBAUTHN_RP_ID"];
      const previousDisplayName = process.env["SUPABASE_AUTH_WEBAUTHN_RP_DISPLAY_NAME"];
      const previousOrigins = process.env["SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS"];
      process.env["SUPABASE_AUTH_WEBAUTHN_RP_ID"] = "env-rp-id";
      process.env["SUPABASE_AUTH_WEBAUTHN_RP_DISPLAY_NAME"] = "Env Display Name";
      process.env["SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS"] = "http://a.example,http://b.example";
      const { layer, child } = setup({
        configContents:
          'project_id = "demo"\n[auth.webauthn]\nrp_id = "toml-rp-id"\nrp_display_name = "TOML Display Name"\nrp_origins = ["http://toml.example"]\n',
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const gotrueCreate = child.spawned.find(
          (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
        );
        expect(gotrueCreate?.env["GOTRUE_WEBAUTHN_RP_ID"]).toBe("env-rp-id");
        expect(gotrueCreate?.env["GOTRUE_WEBAUTHN_RP_DISPLAY_NAME"]).toBe("Env Display Name");
        expect(gotrueCreate?.env["GOTRUE_WEBAUTHN_RP_ORIGINS"]).toBe(
          "http://a.example,http://b.example",
        );
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousRpId === undefined) delete process.env["SUPABASE_AUTH_WEBAUTHN_RP_ID"];
            else process.env["SUPABASE_AUTH_WEBAUTHN_RP_ID"] = previousRpId;
            if (previousDisplayName === undefined)
              delete process.env["SUPABASE_AUTH_WEBAUTHN_RP_DISPLAY_NAME"];
            else process.env["SUPABASE_AUTH_WEBAUTHN_RP_DISPLAY_NAME"] = previousDisplayName;
            if (previousOrigins === undefined)
              delete process.env["SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS"];
            else process.env["SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS"] = previousOrigins;
          }),
        ),
      );
    });

    it.live(
      "coerces an env(...)-resolved passkey enabled string instead of reading it as disabled",
      () => {
        // `auth.passkey`/`auth.webauthn` have no `@supabase/config` schema, so the pre-decode
        // `env(...)` walker substitutes the real value but leaves it a raw string (no type
        // coercion for schema-unmodeled paths) — a strict `=== true` check would silently read
        // this valid config as disabled.
        const previous = process.env["PASSKEY_ENABLED"];
        process.env["PASSKEY_ENABLED"] = "true";
        const { layer, child } = setup({
          configContents:
            'project_id = "demo"\n[auth.passkey]\nenabled = "env(PASSKEY_ENABLED)"\n[auth.webauthn]\nrp_id = "localhost"\nrp_origins = ["http://localhost:3000"]\n',
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const gotrueCreate = child.spawned.find(
            (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
          );
          expect(gotrueCreate?.env["GOTRUE_PASSKEY_ENABLED"]).toBe("true");
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["PASSKEY_ENABLED"];
              else process.env["PASSKEY_ENABLED"] = previous;
            }),
          ),
        );
      },
    );

    it.live(
      "splits an env(...)-resolved comma-separated rp_origins string instead of dropping it to []",
      () => {
        const previous = process.env["RP_ORIGINS"];
        process.env["RP_ORIGINS"] = "http://a.example,http://b.example";
        const { layer, child } = setup({
          configContents:
            'project_id = "demo"\n[auth.passkey]\nenabled = true\n[auth.webauthn]\nrp_id = "localhost"\nrp_origins = "env(RP_ORIGINS)"\n',
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const gotrueCreate = child.spawned.find(
            (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_auth_"),
          );
          expect(gotrueCreate?.env["GOTRUE_WEBAUTHN_RP_ORIGINS"]).toBe(
            "http://a.example,http://b.example",
          );
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["RP_ORIGINS"];
              else process.env["RP_ORIGINS"] = previous;
            }),
          ),
        );
      },
    );
  });

  describe("SUPABASE_EDGE_RUNTIME_POLICY override", () => {
    it.live("honors the env-overridden Edge Runtime request policy", () => {
      const previous = process.env["SUPABASE_EDGE_RUNTIME_POLICY"];
      process.env["SUPABASE_EDGE_RUNTIME_POLICY"] = "per_worker";
      const { layer, child } = setup({
        configContents: 'project_id = "demo"\n[edge_runtime]\npolicy = "oneshot"\n',
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const runCalls = child.spawned.filter((s) => isEdgeRuntimeCreate(s.args));
        const entrypointCommand = runCalls[0]?.args.at(-1) ?? "";
        expect(entrypointCommand).toContain("--policy=per_worker");
        expect(entrypointCommand).not.toContain("--policy=oneshot");
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_EDGE_RUNTIME_POLICY"];
            else process.env["SUPABASE_EDGE_RUNTIME_POLICY"] = previous;
          }),
        ),
      );
    });
  });
});
