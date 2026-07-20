import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

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
  useLegacyTempWorkdir,
} from "../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
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
import { LEGACY_START_EXCLUDABLE_KEYS } from "./start.exclude.ts";
import type { LegacyStartFlags } from "./start.command.ts";
import { legacyStart } from "./start.handler.ts";
import {
  LEGACY_KONG_LOCAL_TLS_CERT,
  LEGACY_KONG_LOCAL_TLS_KEY,
} from "./templates/kong-local-tls.ts";

const tempRoot = useLegacyTempWorkdir("supabase-start-int-");

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
  opts: { readonly failSpawn?: boolean } = {},
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

function containerNameFromCreateArgs(args: ReadonlyArray<string>): string {
  const nameIndex = args.indexOf("--name");
  return nameIndex !== -1 ? (args[nameIndex + 1] ?? "unknown") : "unknown";
}

function createdContainerNames(spawned: ReadonlyArray<SpawnRecord>): ReadonlyArray<string> {
  return spawned
    .filter((s) => s.args[0] === "create")
    .map((s) => containerNameFromCreateArgs(s.args));
}

function rollbackWasAttempted(spawned: ReadonlyArray<SpawnRecord>): boolean {
  return spawned.some((s) => s.args[0] === "container" && s.args[1] === "prune");
}

/**
 * Stateful default route: a container only inspects successfully once it has
 * actually been "created" — mirrors real Docker semantics and is what makes
 * `legacyStart`'s own "already running" existence check correctly report
 * `false` before bring-up and `true` for any container this same run created
 * (e.g. Postgres's own post-create health wait).
 */
function defaultRoute(opts: { readonly neverHealthy?: ReadonlySet<string> } = {}) {
  const created = new Set<string>();
  return (args: ReadonlyArray<string>): RouteResult => {
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
    // `legacyStartVolumeExists` now distinguishes a confirmed "not found" from
    // any other inspect error (matching Go's `errdefs.IsNotFound` gate) — the
    // stderr text is what makes this simulate a genuinely fresh/non-existent
    // volume rather than an ambiguous inspect failure.
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
 * `SetupLocalDatabase`-equivalent path (`legacyStartSetupLocalDatabase`) needs an
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
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, calls };
}

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly route?: (args: ReadonlyArray<string>) => RouteResult;
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
  });
  const dbSession = fakeDbSession();

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
    // never reaches `legacyStartSetupLocalDatabase`/`legacySeedBucketsRun`, but
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
    Layer.succeed(LegacyNetworkIdFlag, opts.networkId ?? Option.none()),
    mockTty({ stdinIsTty: false }),
    mockStdin(false),
  );

  return { workdir, out, telemetry, analytics, child, dbSession, layer };
}

/**
 * Maps each of the 13 valid `--exclude` keys (`start.exclude.ts`) to the
 * container-name suffix(es) that key skips, for the parameterized exclusion
 * matrix test below. `storage-api` is compound: excluding it also disables
 * ImgProxy (`start.gates.ts`'s `imgproxy: storage && ...` dependency).
 * `edge-runtime` maps to no suffix at all here — it DOES really start now
 * (`legacyStartEdgeRuntimeContainer`, a direct `docker run -d`, never a
 * `docker create`), so `--exclude edge-runtime` is exercised by its own
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
        // The FIRST inspect (`AssertSupabaseDbIsRunning`) only needs to prove the container
        // exists; the SECOND inspect (Go's `status.Run` re-check, `!ignoreHealthCheck`) is what
        // actually gates on `Running`/`Health` — a container can transition between the two.
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
  });

  describe("config load / validation failures", () => {
    it.live("fails when --workdir/SUPABASE_WORKDIR points at a missing path", () => {
      // Go's `ChangeWorkDir` (`apps/cli-go/internal/utils/misc.go:231-250`) `os.Chdir`s the
      // explicit workdir before config load or any Docker call — a missing path must fail
      // immediately, matching `status`/`stop`'s own equivalent test.
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
        // (`resolveGotruePasskeyWebauthn`, `resolveGotrueExternalProviders`,
        // `buildKongEmailTemplateMounts`, `values.analyticsBackend`) in one pass, none of
        // which interact with each other. A malformed `db.health_timeout` is exercised
        // separately below (it now hard-fails the whole command, matching Go, so it can't
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
content_path = "./templates/confirmation.html"

[auth.email.notification.custom_notice]
enabled = true
content_path = "./templates/custom_notice.html"
`,
        });
        // `Config.Validate` (step 2, before this handler's own `buildKongEmailTemplateMounts`
        // ever runs) reads both content_path files for real — template paths resolve against
        // the workdir itself, notification paths against `<workdir>/supabase`.
        mkdirSync(join(workdir, "templates"), { recursive: true });
        writeFileSync(join(workdir, "templates", "confirmation.html"), "<html></html>");
        mkdirSync(join(workdir, "supabase", "templates"), { recursive: true });
        writeFileSync(
          join(workdir, "supabase", "templates", "custom_notice.html"),
          "<html></html>",
        );
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const createdNames = createdContainerNames(child.spawned);
          expect(createdNames.some((name) => name.includes("_pooler_"))).toBe(true);
          expect(createdNames.some((name) => name.includes("_auth_"))).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      // Go's own backoff policy for "0s" performs exactly one immediate health
      // probe with no retries (`internal/db/start/start.go:192-198` — the retry
      // count is `uint64(timeout.Seconds())`, and the backoff library stops
      // immediately at 0) — this is NOT a 30s fallback. The mock's default route
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
      "fails config loading on an unparseable db.health_timeout, matching Go's Config.Load",
      () => {
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
          expect(rollbackWasAttempted(child.spawned)).toBe(true);
        }).pipe(Effect.provide(layer));
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
        // Go's `Storage.ImageTransformation` is a nil-unless-declared pointer
        // (`pkg/config/storage.go:16`) — with no `[storage.image_transformation]` table, the env
        // var is never even looked up (`start.go:302-303`'s `!= nil && .Enabled` gate), so ImgProxy
        // must stay off even though storage itself is enabled.
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
    /** The three PG15+ one-shot migrate jobs (`legacyStartSetupLocalDatabase`'s `LegacyDockerRun` calls) — a plain `docker run --rm ...`, never `-d`, distinct from Edge Runtime's own detached `docker run -d`. */
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
      "resolves an excluded service's migrate-job image through a project-dotenv-only registry override",
      () => {
        // The auth/realtime/storage migrate jobs run regardless of `--exclude` (Go parity —
        // see this describe block's own header comment), but `--exclude gotrue` removes the
        // gotrue image from `imagePlan`, which used to make its migrate-job image fall back to
        // `LegacyDockerRun`'s ambient-`process.env`-only registry resolver — invisible to a
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
          expect(authMigrateJob?.args.some((arg) => arg.includes("registry.example.com"))).toBe(
            true,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "does not attempt to resolve an excluded service's migrate-job image on a non-fresh-volume restart",
      () => {
        // Go's own pre-pull (`ensureImagesCached`, `start.go:237-262`) only ever touches
        // non-excluded services, and the one-shot setup-job images are resolved lazily,
        // only from inside `initSchema15` when it actually runs — a fresh volume AND
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
    /** Edge Runtime's own bring-up (`legacyStartEdgeRuntimeContainer`) is a direct, detached `docker run -d ...`, never a `docker create`+`docker start` pair like every other service. */
    function edgeRuntimeRunCalls(spawned: ReadonlyArray<SpawnRecord>): ReadonlyArray<SpawnRecord> {
      return spawned.filter((s) => s.args[0] === "run" && s.args[1] === "-d");
    }

    it.live("starts a real container via docker run -d when enabled and not excluded", () => {
      const { layer, child } = setup();
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const runCalls = edgeRuntimeRunCalls(child.spawned);
        expect(runCalls).toHaveLength(1);
        expect(runCalls[0]?.args).toContain("--name");
        const nameIndex = runCalls[0]?.args.indexOf("--name") ?? -1;
        expect(runCalls[0]?.args[nameIndex + 1]).toContain("_edge_runtime_");
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
      "keeps the host-side bind-mount temp files after a successful bring-up (no eager cleanup)",
      () => {
        // Staged under `<workdir>/supabase/.temp/start-secrets/<container>/main/`
        // — a deterministic, persistent path (not `os.tmpdir()`), so a later
        // `stop`/rollback can reclaim it via `legacyCleanupStartSecrets`. See
        // the "reclaims Edge Runtime's own temp secret artifacts on stop" test
        // below for that cleanup behavior.
        const { layer, child, workdir } = setup();
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const runArgs = edgeRuntimeRunCalls(child.spawned)[0]?.args ?? [];
          const bindValues = runArgs.flatMap((arg, i) => (runArgs[i - 1] === "-v" ? [arg] : []));
          const stagingRoot = join(workdir, "supabase", ".temp", "start-secrets");
          const mainTemplateBind = bindValues.find(
            (bind) => bind.startsWith(stagingRoot) && bind.includes(`${join("main", "index.ts")}:`),
          );
          expect(mainTemplateBind).toBeDefined();
          const hostPath = mainTemplateBind?.split(":")[0] ?? "";
          try {
            expect(existsSync(hostPath)).toBe(true);
          } finally {
            rmSync(stagingRoot, { recursive: true, force: true });
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "resolves a per-function env(...) ref against the real env var, not the literal string",
      () => {
        // `config.functions.<slug>.env.<VAR>` is schema-deferred (`env(...)`)
        // until `resolveProjectSubtree` runs — without that step Edge Runtime
        // would receive the literal string "env(FOO_SECRET)" instead of the
        // actual secret.
        const previous = process.env["FOO_SECRET"];
        process.env["FOO_SECRET"] = "the-real-secret-value";
        const workdir = tempRoot.current;
        mkdirSync(join(workdir, "supabase", "functions", "foo"), { recursive: true });
        writeFileSync(join(workdir, "supabase", "functions", "foo", "index.ts"), "export {};\n");
        const { layer, child } = setup({
          configContents:
            'project_id = "demo"\n[functions.foo]\nenabled = true\n[functions.foo.env]\nFOO_SECRET = "env(FOO_SECRET)"\n',
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const runArgs = edgeRuntimeRunCalls(child.spawned)[0]?.args ?? [];
          const envFileIndex = runArgs.indexOf("--env-file");
          expect(envFileIndex).toBeGreaterThanOrEqual(0);
          const envFilePath = runArgs[envFileIndex + 1] ?? "";
          const envFileContents = readFileSync(envFilePath, "utf8");
          try {
            expect(envFileContents).toContain("the-real-secret-value");
            expect(envFileContents).not.toContain("env(FOO_SECRET)");
          } finally {
            rmSync(dirname(envFilePath), { recursive: true, force: true });
          }
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env["FOO_SECRET"];
              else process.env["FOO_SECRET"] = previous;
              rmSync(join(workdir, "supabase", "functions"), { recursive: true, force: true });
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
          // Force every image through the pull path instead of the "already cached" shortcut.
          if (args[0] === "image" && args[1] === "inspect") return { exitCode: 1 };
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
          if (args[0] === "image" && args[1] === "inspect") return { exitCode: 1 };
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
  });

  describe("rollback on bring-up failure", () => {
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
          expect(serialized).toContain("LegacyStartNetworkCreateError");
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
          expect(serialized).toContain("LegacyStartContainerCreateError");
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
            expect(serialized).toContain("LegacyStartContainerStartError");
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
      "fails and rolls back on a malformed auth.email.max_frequency instead of crashing past rollback",
      () => {
        // `auth.email.max_frequency` is a plain, unvalidated string in `@supabase/config`'s
        // schema, so a malformed Go-duration value reaches `buildLegacyGotrueEnv`'s
        // `legacyParseGoDuration` call unchecked. That call is a synchronous throw, not a
        // typed Effect failure — without `Effect.catchDefect` around the per-service spec
        // builder in `start.handler.ts`, this would surface as an uncaught defect that
        // bypasses `Effect.tapError`'s rollback entirely, leaking the network/Postgres/
        // Logflare/Vector/Kong containers already created by the time GoTrue's spec is built.
        const { layer, child } = setup({
          configContents: 'project_id = "demo"\n[auth.email]\nmax_frequency = "not-a-duration"\n',
        });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStart(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const serialized = JSON.stringify(exit.cause);
            expect(serialized).toContain("LegacyStartInvalidConfigError");
            expect(serialized).toContain("invalid config for gotrue");
          }
          expect(rollbackWasAttempted(child.spawned)).toBe(true);
        }).pipe(Effect.provide(layer));
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
  // wait (`lib/health-check.ts`'s default), hence the generous timeout.
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
        // Go never fires `cli_stack_started` on the ignored-unhealthy
        // fallthrough (`start.go:1287` sits after the `if err != nil` block) —
        // only a genuine bulk health-check SUCCESS reaches that capture.
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
          expect(storageImageInspect?.args[2]).toMatch(/:v1\.2\.3$/);
        }).pipe(Effect.provide(layer));
      },
    );
  });

  describe("db.root_key", () => {
    it.live("stages a configured db.root_key as the Postgres container's pgsodium root key", () => {
      const { layer, workdir, child } = setup({
        configContents: 'project_id = "demo"\n[db]\nroot_key = "custom-root-key-value"\n',
      });
      return Effect.gen(function* () {
        yield* legacyStart(flags());
        const containerName = legacyServiceContainerName("db", "demo");
        const secretDir = join(workdir, "supabase", ".temp", "start-secrets", containerName);
        const staged = readFileSync(join(secretDir, "secret-0"), "utf8");
        expect(staged).toBe("custom-root-key-value");
        expect(child.spawned.some((s) => s.args[0] === "create")).toBe(true);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("container-not-found stderr shapes", () => {
    it.live(
      "brings up the stack when the DB container's inspect reports 'No such object' instead of 'No such container'",
      () => {
        // Docker/Podman report a missing container as either "No such container" or "No such
        // object" depending on daemon version/CLI path — `isContainerNotFoundMessage` must
        // recognize both, or `legacyStart`'s "not running, bring up the stack" branch never
        // fires and the inspect failure propagates instead.
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
        const { layer, child } = setup();
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
        const { layer, child, workdir } = setup();
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const kongCreate = child.spawned.find(
            (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_kong_"),
          );
          const kongContainerName = containerNameFromCreateArgs(kongCreate?.args ?? []);
          const secretsDir = join(workdir, "supabase", ".temp", "start-secrets", kongContainerName);
          // secretFiles order in kong.service.ts: [kong.yml, localhost.crt, localhost.key].
          const crtContent = readFileSync(join(secretsDir, "secret-1"), "utf-8");
          const keyContent = readFileSync(join(secretsDir, "secret-2"), "utf-8");
          expect(crtContent).toBe(LEGACY_KONG_LOCAL_TLS_CERT);
          expect(keyContent).toBe(LEGACY_KONG_LOCAL_TLS_KEY);
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
        const { layer, workdir, child } = setup({
          configContents: 'project_id = "demo"\n[api.tls]\nenabled = true\n',
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
          const kongCreate = child.spawned.find(
            (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_kong_"),
          );
          const kongContainerName = containerNameFromCreateArgs(kongCreate?.args ?? []);
          const secretsDir = join(workdir, "supabase", ".temp", "start-secrets", kongContainerName);
          const crtContent = readFileSync(join(secretsDir, "secret-1"), "utf-8");
          const keyContent = readFileSync(join(secretsDir, "secret-2"), "utf-8");
          expect(crtContent).toBe("-----BEGIN CERTIFICATE-----env-cert");
          expect(keyContent).toBe("-----BEGIN PRIVATE KEY-----env-key");
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
    // Go nests the entire TLS cert/key disk read inside `if c.Api.Enabled`
    // (`pkg/config/config.go:1006-1027`) — when API is disabled (however that happened), Kong
    // keeps its embedded default cert/key regardless of `api.tls.enabled`/cert_path/key_path.
    it.live(
      "skips the configured cert/key read for Kong when API is disabled only via env override",
      () => {
        const previous = process.env["SUPABASE_API_ENABLED"];
        process.env["SUPABASE_API_ENABLED"] = "false";
        const { layer, workdir, child } = setup({
          configContents: 'project_id = "demo"\n[api.tls]\nenabled = true\n',
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
          const kongCreate = child.spawned.find(
            (s) => s.args[0] === "create" && containerNameFromCreateArgs(s.args).includes("_kong_"),
          );
          const kongContainerName = containerNameFromCreateArgs(kongCreate?.args ?? []);
          const secretsDir = join(workdir, "supabase", ".temp", "start-secrets", kongContainerName);
          const crtContent = readFileSync(join(secretsDir, "secret-1"), "utf-8");
          const keyContent = readFileSync(join(secretsDir, "secret-2"), "utf-8");
          expect(crtContent).toBe(LEGACY_KONG_LOCAL_TLS_CERT);
          expect(keyContent).toBe(LEGACY_KONG_LOCAL_TLS_KEY);
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
    // Go's test vector (`apps/cli-go/pkg/config/secret_test.go`): this ciphertext
    // decrypts to "value" under the keypair below — same fixture already used in
    // `legacy-local-config-values.unit.test.ts`'s "encrypted auth secrets" suite.
    const VAULT_PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
    const VAULT_ENCRYPTED =
      "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";

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
            'project_id = "demo"\n[edge_runtime.secrets]\nMY_SECRET = "shh-do-not-tell"\n',
        });
        return Effect.gen(function* () {
          yield* legacyStart(flags());
          const edgeRuntimeRunCall = child.spawned.find(
            (s) => s.args[0] === "run" && s.args[1] === "-d",
          );
          const args = edgeRuntimeRunCall?.args ?? [];
          const envFileIndex = args.indexOf("--env-file");
          const envFilePath = envFileIndex !== -1 ? args[envFileIndex + 1] : undefined;
          expect(envFilePath).toBeDefined();
          const envFileContent = readFileSync(envFilePath ?? "", "utf-8");
          expect(envFileContent).toContain("MY_SECRET=shh-do-not-tell");
        }).pipe(Effect.provide(layer));
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
        // this valid Go config as disabled.
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
        const runCalls = child.spawned.filter((s) => s.args[0] === "run" && s.args[1] === "-d");
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
