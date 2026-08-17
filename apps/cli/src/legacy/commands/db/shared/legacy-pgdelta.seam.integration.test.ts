import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  mockLegacyCliConfig,
  mockLegacyShadowContainerCliSpawner,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput, mockRuntimeInfo } from "../../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import {
  LegacyDebugFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
} from "../../../../shared/legacy/global-flags.ts";
import {
  LegacyDbConnection,
  type LegacyDbSession,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import {
  type LegacyEdgeRuntimeRunOpts,
  LegacyEdgeRuntimeScript,
} from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LEGACY_SUGGEST_DOCKER_INSTALL } from "../../../shared/legacy-docker-suggest.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";
import { legacyDeclarativeSeamLayer } from "./legacy-pgdelta.seam.layer.ts";
import { LegacyDeclarativeSeam } from "./legacy-pgdelta.seam.service.ts";

/**
 * Integration coverage for the fully-native `legacyDeclarativeSeamLayer` (CLI-1970) —
 * `generate`/`sync`'s own integration tests stub `LegacyDeclarativeSeam` entirely
 * (per its own service doc comment), so this file is the only place the real
 * shadow-provisioning composition (`legacy-pgdelta.cache.ts`'s
 * `legacyExportBaselineCatalogRef`/`legacyExportDeclarativeCatalogRef`) gets
 * exercised end-to-end. Mirrors `declarative.orchestrate.integration.test.ts`'s
 * real-shadow-stack pattern (`mockLegacyShadowContainerCliSpawner` + a fake
 * `LegacyDbConnection`/`LegacyDockerRun`/`LegacyEdgeRuntimeScript`).
 */

const alwaysReadyHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

function fakeShadowDbConnection() {
  const layer = Layer.succeed(LegacyDbConnection, {
    connect: (_cfg: LegacyPgConnInput) =>
      Effect.sync(() => {
        const session: LegacyDbSession = {
          exec: () => Effect.void,
          query: () => Effect.succeed([]),
          extensionExists: () => Effect.succeed(false),
          copyToCsv: () => Effect.succeed(new Uint8Array()),
          queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        };
        return session;
      }),
  });
  return { layer };
}

/** The shadow's own PG15+ one-shot platform-baseline job(s) — Go's `initSchema15`. */
function fakeShadowSetupDocker() {
  const layer = Layer.succeed(LegacyDockerRun, {
    run: () => Effect.die("run unused"),
    runCapture: () => Effect.die("runCapture unused"),
    runStream: () => Effect.succeed({ exitCode: 0, stderr: "" }),
  });
  return { layer };
}

/**
 * Distinguishes the two pg-delta edge-runtime scripts this seam invokes by `errPrefix`
 * (`legacyApplyDeclarativePgDelta`'s declarative-apply script vs.
 * `legacyExportCatalogPgDelta`'s catalog-export script — `legacy-pgdelta.apply.ts`/
 * `legacy-pgdelta.ts`'s own literal `errPrefix` strings).
 */
function fakeEdgeRuntime() {
  const calls: Array<LegacyEdgeRuntimeRunOpts> = [];
  const layer = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (opts: LegacyEdgeRuntimeRunOpts) => {
      calls.push(opts);
      if (opts.errPrefix === "error running pg-delta script") {
        return Effect.succeed({
          stdout: JSON.stringify({
            status: "success",
            totalApplied: 0,
            totalRounds: 1,
            totalSkipped: 0,
          }),
          stderr: "",
        });
      }
      return Effect.succeed({ stdout: '{"schemas":[]}', stderr: "" });
    },
  });
  return { layer, calls };
}

const sslProbe = Layer.succeed(LegacyPgDeltaSslProbe, {
  requireSsl: () => Effect.succeed(false),
  requireSslForHost: () => Effect.succeed(false),
});

function setup(
  workdir: string,
  opts: { readonly failCreate?: boolean; readonly dbInspectFailsWith?: string } = {},
) {
  const out = mockOutput();
  const shadowSpawner = mockLegacyShadowContainerCliSpawner({
    failCreate: opts.failCreate,
    dbInspectFailsWith: opts.dbInspectFailsWith,
  });
  const dbConnection = fakeShadowDbConnection();
  const docker = fakeShadowSetupDocker();
  const edge = fakeEdgeRuntime();
  const cliConfig = mockLegacyCliConfig({ workdir, projectId: Option.none() });

  // Every service `legacyDeclarativeSeamLayer` needs must be provided directly into `seam`
  // itself — the "provide doesn't share to siblings inside Layer.mergeAll" rule (legacy
  // CLAUDE.md item 5) applies here too: `out.layer`/`mockRuntimeInfo()`/the global-flag
  // `Layer.succeed`s below are ALSO listed as `layer`'s own top-level members (so the test
  // body itself can resolve `Output`/etc.), but that doesn't satisfy `seam`'s OWN identical
  // requirements as a sibling entry in the same merge.
  const seam = legacyDeclarativeSeamLayer.pipe(
    Layer.provide(cliConfig),
    Layer.provide(dbConnection.layer),
    Layer.provide(docker.layer),
    Layer.provide(edge.layer),
    Layer.provide(sslProbe),
    Layer.provide(alwaysReadyHttpClientLayer),
    Layer.provide(out.layer),
    Layer.provide(mockRuntimeInfo()),
    Layer.provide(Layer.succeed(LegacyNetworkIdFlag, Option.none())),
    Layer.provide(Layer.succeed(LegacyExperimentalFlag, false)),
    Layer.provide(Layer.succeed(LegacyDebugFlag, false)),
    Layer.provide(Layer.succeed(CliArgs, { args: [] })),
    // The fake `ChildProcessSpawner` must be provided BEFORE the real `BunServices.layer`
    // fallback below, so it wins over the real one for whatever `ChildProcessSpawner`
    // `seam` itself resolves — `Layer.provide` fully resolves each requirement it can
    // satisfy as it's applied, so `BunServices.layer` only ever fills in `FileSystem`/`Path`.
    Layer.provide(shadowSpawner.layer),
    Layer.provide(BunServices.layer),
  );

  const layer = Layer.mergeAll(
    BunServices.layer,
    out.layer,
    shadowSpawner.layer,
    dbConnection.layer,
    docker.layer,
    edge.layer,
    sslProbe,
    alwaysReadyHttpClientLayer,
    cliConfig,
    mockRuntimeInfo(),
    Layer.succeed(LegacyNetworkIdFlag, Option.none()),
    Layer.succeed(LegacyExperimentalFlag, false),
    Layer.succeed(LegacyDebugFlag, false),
    Layer.succeed(CliArgs, { args: [] }),
    seam,
  );

  return { layer, out, edgeCalls: edge.calls, shadowSpawned: shadowSpawner.spawned };
}

const failError = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

describe("legacyDeclarativeSeamLayer.exportCatalog", () => {
  it.effect(
    "provisions a shadow on a baseline cache miss, then reuses the cached catalog with no further container work",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "legacy-pgdelta-seam-"));
      const { layer, out, shadowSpawned } = setup(dir);
      return Effect.gen(function* () {
        const seam = yield* LegacyDeclarativeSeam;

        const firstRef = yield* seam.exportCatalog({ mode: "baseline", noCache: false });
        expect(firstRef).toMatch(/^supabase[/\\]\.temp[/\\]pgdelta[/\\]catalog-baseline-.*\.json$/);
        expect(readFileSync(join(dir, firstRef), "utf8")).toBe('{"schemas":[]}');
        expect(out.stderrText).toContain("Creating shadow database...\n");
        expect(shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
        expect(shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);

        // Cache hit: same ref, zero additional container work.
        const secondRef = yield* seam.exportCatalog({ mode: "baseline", noCache: false });
        expect(secondRef).toBe(firstRef);
        expect(shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
        expect(shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);

        rmSync(dir, { recursive: true, force: true });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "writes catalog-nocache-declarative.json on --no-cache, applying the declarative directory first",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "legacy-pgdelta-seam-"));
      const declDir = join(dir, "supabase", "schemas");
      mkdirSync(declDir, { recursive: true });
      writeFileSync(join(declDir, "public.sql"), "create table t ();");
      const { layer, edgeCalls, shadowSpawned } = setup(dir);
      return Effect.gen(function* () {
        const seam = yield* LegacyDeclarativeSeam;
        const ref = yield* seam.exportCatalog({ mode: "declarative", noCache: true });
        expect(ref).toBe(join("supabase", ".temp", "pgdelta", "catalog-nocache-declarative.json"));
        expect(readFileSync(join(dir, ref), "utf8")).toBe('{"schemas":[]}');
        expect(edgeCalls.some((c) => c.errPrefix === "error running pg-delta script")).toBe(true);
        expect(shadowSpawned.filter((c) => c.args[0] === "create")).toHaveLength(1);
        expect(shadowSpawned.filter((c) => c.args[0] === "rm")).toHaveLength(1);
        rmSync(dir, { recursive: true, force: true });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("maps a shadow-provisioning failure to LegacyDeclarativeShadowDbError", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-pgdelta-seam-"));
    const { layer } = setup(dir, { failCreate: true });
    return Effect.gen(function* () {
      const seam = yield* LegacyDeclarativeSeam;
      const exit = yield* seam.exportCatalog({ mode: "baseline", noCache: true }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const error = failError(exit);
      expect(error).toBeInstanceOf(LegacyDeclarativeShadowDbError);
      expect((error as LegacyDeclarativeShadowDbError).message).toContain(
        "failed to provision the shadow database:",
      );
      rmSync(dir, { recursive: true, force: true });
    }).pipe(Effect.provide(layer));
  });
});

describe("legacyDeclarativeSeamLayer.ensureLocalDatabaseStarted", () => {
  it.effect(
    "carries the inspect failure's daemon marker AND recovery suggestion onto the seam error",
    () => {
      // Go's `AssertSupabaseDbIsRunning` sets `CmdSuggestion = suggestDockerInstall` on a
      // daemon-connection failure — the seam's inspect-error mapping must preserve both the
      // daemon classification and that suggestion, or the normalizer renders its generic
      // debug hint instead of the actionable Docker recovery text (review: the start-failure
      // catch below it already propagates `suggestion`; this asserts the inspect mapping does
      // too).
      const dir = mkdtempSync(join(tmpdir(), "legacy-pgdelta-seam-"));
      const { layer } = setup(dir, {
        dbInspectFailsWith:
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      });
      return Effect.gen(function* () {
        const seam = yield* LegacyDeclarativeSeam;
        const exit = yield* seam.ensureLocalDatabaseStarted().pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const error = failError(exit);
        expect(error).toBeInstanceOf(LegacyDeclarativeShadowDbError);
        const shadowError = error as LegacyDeclarativeShadowDbError;
        expect(shadowError.docker).toBe("daemon");
        expect(shadowError.suggestion).toBe(LEGACY_SUGGEST_DOCKER_INSTALL);
        rmSync(dir, { recursive: true, force: true });
      }).pipe(Effect.provide(layer));
    },
  );
});
