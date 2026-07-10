import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  return { layer, createdBucketRequests };
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
      "brings up the stack with every optional config.toml section populated (bigquery analytics, session pool mode, passkey/webauthn, external provider, SMTP, email templates, an unparseable db.health_timeout)",
      () => {
        // Exercises the config-document-shape branches `start.handler.ts` itself owns
        // (`resolveGotruePasskeyWebauthn`, `resolveGotrueExternalProviders`,
        // `buildKongEmailTemplateMounts`, `toAnalyticsBackend`, `toPoolMode`,
        // `resolveDbHealthTimeoutSeconds`'s parse-failure fallback) in one pass, none of which
        // interact with each other. `db.health_timeout` being unparseable only matters if
        // Postgres's own health wait actually needs to retry — it doesn't here (default route
        // heals immediately), so this stays fast despite falling back to the 30s default.
        const { layer, workdir, child } = setup({
          configContents: `project_id = "demo"

[analytics]
backend = "bigquery"
gcp_project_id = "gcp-project"
gcp_project_number = "123456789"
gcp_jwt_path = "gcp-key.json"

[db]
health_timeout = "not-a-duration"

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
      "falls back to the default health-check timeout on a zero db.health_timeout, and to blank webauthn fields on an empty [auth.webauthn] section",
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
      10_000,
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
});
