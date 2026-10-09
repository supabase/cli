import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { afterEach, beforeEach, vi } from "vitest";

import {
  mockCommandSettings,
  mockLocalDockerEngineUnavailableLayer,
  mockShadowContainerCliSpawner,
  useShadowCacheDisabled,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { configValuesLayer } from "../../../../tests/helpers/config-snapshot-layer.ts";
import { mockOutput, mockRuntimeInfo } from "../../../../tests/helpers/mocks.ts";
import { unusedStackServices } from "../../../../tests/helpers/unused-stack.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import {
  DebugFlag,
  ExperimentalFlag,
  NetworkIdFlag,
} from "../../../command-internal/global-flags.ts";
import {
  DbConnection,
  type DbSession,
  type PgConnInput,
} from "../../../command-internal/db-connection.service.ts";
import { DockerRun } from "../../../command-internal/docker-run.service.ts";
import { dockerfileServiceImageRaw } from "../../../shared/services/dockerfile-images.ts";
import { SUGGEST_DOCKER_INSTALL } from "../../../command-internal/docker-suggest.ts";
import { stackBackendLayer } from "../../../command-internal/stack-backend.ts";
import { DeclarativeShadowDbError } from "./pgdelta.errors.ts";
import { declarativeSeamLayer } from "./pgdelta.seam.layer.ts";
import { DeclarativeSeam } from "./pgdelta.seam.service.ts";

// This fixture catalog's pin must be keyed to the Dockerfile's own `pg` tag, or `toSlimImage`
// would find no match and fall back to the upstream (non-slim) image regardless of
// `SUPABASE_USE_SLIM_IMAGES` — masking the family-mismatch check below. `vi.hoisted` runs before
// every top-level `import` (including this file's own), so `dockerfileServiceImageRaw` isn't
// bound yet when this runs; `require` (CJS, unaffected by that ESM hoisting order) reads the
// Dockerfile directly instead, keeping this correct across every future Dockerfile bump.
const pgTag = vi.hoisted(() => {
  const fs: typeof import("node:fs") = require("node:fs");
  const url: typeof import("node:url") = require("node:url");
  const dockerfilePath = url.fileURLToPath(
    new URL("../../../shared/services/Dockerfile", import.meta.url),
  );
  const match = /^FROM\s+supabase\/postgres:(\S+)\s+AS\s+pg$/m.exec(
    fs.readFileSync(dockerfilePath, "utf8"),
  );
  if (match?.[1] === undefined) throw new Error("pg tag not found in the Dockerfile");
  return match[1];
});

vi.mock("@supabase/stack/internal/artifacts", () => {
  const digest = "d348483ad1141c54bfb4eaae801f5385fe1c2970fc106f95f531b5247092d52c";
  const nativePin = { archive: digest, manifest: digest };
  return {
    catalogPins: () => [
      {
        service: "database",
        sourceService: "postgres",
        pin: {
          upstreamVersion: pgTag,
          revision: 0,
          image: `ghcr.io/supabase/cli/postgres:${pgTag}-r0@sha256:${digest}`,
          natives: {
            "darwin-arm64": nativePin,
            "linux-amd64": nativePin,
            "linux-arm64": nativePin,
          },
        },
      },
    ],
  };
});

/**
 * Integration coverage for the fully-native `declarativeSeamLayer`: `generate`/`sync`'s own
 * tests stub `DeclarativeSeam` entirely, so this file is the only place the real local-database
 * bring-up composition is exercised end-to-end, with a fake `DbConnection`/`DockerRun`.
 */

const alwaysReadyHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

function fakeShadowDbConnection() {
  const layer = Layer.succeed(DbConnection, {
    connect: (_cfg: PgConnInput) =>
      Effect.sync(() => {
        const session: DbSession = {
          exec: () => Effect.void,
          execBatch: () => Effect.void,
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

/** The shadow's own PG15+ one-shot platform-baseline job(s). */
function fakeShadowSetupDocker() {
  const layer = Layer.succeed(DockerRun, {
    run: () => Effect.die("run unused"),
    runCapture: () => Effect.die("runCapture unused"),
    runStream: () => Effect.succeed({ exitCode: 0, stderr: "" }),
  });
  return { layer };
}

useShadowCacheDisabled();

const tmp = useTempWorkdir("pgdelta-seam-");

function setup(
  workdir: string,
  opts: {
    readonly failCreate?: boolean;
    readonly dbInspectFailsWith?: string;
    readonly dbInspectImage?: string;
    readonly stackBackend?: boolean;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
) {
  const out = mockOutput();
  const shadowSpawner = mockShadowContainerCliSpawner({
    failCreate: opts.failCreate,
    dbInspectFailsWith: opts.dbInspectFailsWith,
    dbInspectImage: opts.dbInspectImage,
  });
  const dbConnection = fakeShadowDbConnection();
  const docker = fakeShadowSetupDocker();
  const cliSettings = mockCommandSettings({ workdir, projectId: Option.none() });

  // Every service `declarativeSeamLayer` needs must be provided directly into `seam`
  // itself — the "provide doesn't share to siblings inside Layer.mergeAll" rule (legacy
  // CLAUDE.md item 5) applies here too: `out.layer`/`mockRuntimeInfo()`/the global-flag
  // `Layer.succeed`s below are ALSO listed as `layer`'s own top-level members (so the test
  // body itself can resolve `Output`/etc.), but that doesn't satisfy `seam`'s OWN identical
  // requirements as a sibling entry in the same merge.
  const seam = declarativeSeamLayer.pipe(
    Layer.provide(configValuesLayer({ output: out.layer, env: opts.env })),
    Layer.provide(cliSettings),
    Layer.provide(dbConnection.layer),
    Layer.provide(docker.layer),
    Layer.provide(alwaysReadyHttpClientLayer),
    Layer.provide(out.layer),
    Layer.provide(mockRuntimeInfo()),
    Layer.provide(Layer.succeed(NetworkIdFlag, Option.none())),
    Layer.provide(Layer.succeed(ExperimentalFlag, false)),
    Layer.provide(Layer.succeed(DebugFlag, false)),
    Layer.provide(Layer.succeed(CliArgs, { args: [] })),
    // The fake `ChildProcessSpawner` must be provided BEFORE the real `BunServices.layer`
    // fallback below, so it wins over the real one for whatever `ChildProcessSpawner`
    // `seam` itself resolves — `Layer.provide` fully resolves each requirement it can
    // satisfy as it's applied, so `BunServices.layer` only ever fills in `FileSystem`/`Path`.
    Layer.provide(shadowSpawner.layer),
    Layer.provide(mockLocalDockerEngineUnavailableLayer),
    Layer.provide(unusedStackServices),
    Layer.provide(BunServices.layer),
  );

  const layer = Layer.mergeAll(
    BunServices.layer,
    out.layer,
    shadowSpawner.layer,
    dbConnection.layer,
    docker.layer,
    alwaysReadyHttpClientLayer,
    cliSettings,
    mockRuntimeInfo(),
    Layer.succeed(NetworkIdFlag, Option.none()),
    Layer.succeed(ExperimentalFlag, false),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(CliArgs, { args: [] }),
    seam,
    ...(opts.stackBackend === true ? [stackBackendLayer("stack")] : []),
  );

  return { layer, out, shadowSpawned: shadowSpawner.spawned };
}

const failError = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

describe("declarativeSeamLayer.ensureLocalDatabaseStarted", () => {
  it.effect(
    "carries the inspect failure's daemon marker AND recovery suggestion onto the seam error",
    () => {
      // A daemon-connection failure carries a Docker-install suggestion — the seam's inspect-error mapping must preserve both the
      // daemon classification and that suggestion, or the normalizer renders its generic
      // debug hint instead of the actionable Docker recovery text (review: the start-failure
      // catch below it already propagates `suggestion`; this asserts the inspect mapping does
      // too).
      const dir = tmp.current;
      const { layer } = setup(dir, {
        dbInspectFailsWith:
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      });
      return Effect.gen(function* () {
        const seam = yield* DeclarativeSeam;
        const exit = yield* seam.ensureLocalDatabaseStarted.pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const error = failError(exit);
        expect(error).toBeInstanceOf(DeclarativeShadowDbError);
        const shadowError = error as DeclarativeShadowDbError;
        expect(shadowError.docker).toBe("daemon");
        expect(shadowError.suggestion).toBe(SUGGEST_DOCKER_INSTALL);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("declarativeSeamLayer.ensureLocalPostgresImageCurrent", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.effect(
    "flags a running docker.io container as stale against a slim-flagged expectation, even on a matching tag",
    () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
      const dir = tmp.current;
      const { layer } = setup(dir, { dbInspectImage: dockerfileServiceImageRaw("pg") });
      return Effect.gen(function* () {
        const seam = yield* DeclarativeSeam;
        const exit = yield* seam.ensureLocalPostgresImageCurrent.pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        const error = failError(exit);
        expect(error).toBeInstanceOf(DeclarativeShadowDbError);
        expect((error as DeclarativeShadowDbError).message).toContain(
          "local Postgres container image is stale",
        );
        expect((error as DeclarativeShadowDbError).message).toContain(
          "same SUPABASE_USE_SLIM_IMAGES setting",
        );
        expect((error as DeclarativeShadowDbError).message).not.toContain("--no-backup");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "inspects the container named by SUPABASE_PROJECT_ID over config.toml's project_id",
    () => {
      const dir = tmp.current;
      const { layer, shadowSpawned } = setup(dir, {
        dbInspectImage: dockerfileServiceImageRaw("pg"),
        env: { SUPABASE_PROJECT_ID: "envproj" },
      });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(dir, "supabase", "config.toml"),
          'project_id = "tomlproj"\n',
        );
        const seam = yield* DeclarativeSeam;
        yield* seam.ensureLocalPostgresImageCurrent.pipe(Effect.exit);
        expect(shadowSpawned.some((call) => call.args.includes("supabase_db_envproj"))).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("flags a stale slim container when only its revision has drifted from a hotfix", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    const dir = tmp.current;
    // Same upstream version and family as the fixture catalog's pin, but at a different
    // revision (r1, a different digest) — the hotfix-drift case this model exists to catch,
    // and the one a bare upstream-version comparison would mask.
    const { layer } = setup(dir, {
      dbInspectImage: `ghcr.io/supabase/cli/postgres:${pgTag}-r1@sha256:${"a".repeat(64)}`,
    });
    return Effect.gen(function* () {
      const seam = yield* DeclarativeSeam;
      const exit = yield* seam.ensureLocalPostgresImageCurrent.pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const error = failError(exit);
      expect(error).toBeInstanceOf(DeclarativeShadowDbError);
      expect((error as DeclarativeShadowDbError).message).toContain(
        "local Postgres container image is stale",
      );
      // Same family (slim vs slim): the generic remediation, not the family-mismatch wording.
      expect((error as DeclarativeShadowDbError).message).not.toContain(
        "same SUPABASE_USE_SLIM_IMAGES setting",
      );
      expect((error as DeclarativeShadowDbError).message).toContain("--no-backup");
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes when a slim container matches the expected image's release and digest", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    const dir = tmp.current;
    // The exact image (release version and digest) the fixture catalog pins at r0.
    const { layer } = setup(dir, {
      dbInspectImage: `ghcr.io/supabase/cli/postgres:${pgTag}-r0@sha256:d348483ad1141c54bfb4eaae801f5385fe1c2970fc106f95f531b5247092d52c`,
    });
    return Effect.gen(function* () {
      const seam = yield* DeclarativeSeam;
      const exit = yield* seam.ensureLocalPostgresImageCurrent.pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("bails out when inspect succeeds but the image name is unparseable", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    const dir = tmp.current;
    const { layer } = setup(dir, { dbInspectImage: "" });
    return Effect.gen(function* () {
      const seam = yield* DeclarativeSeam;
      const exit = yield* seam.ensureLocalPostgresImageCurrent.pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes when the running container matches the expected image's family and tag", () => {
    const dir = tmp.current;
    const { layer } = setup(dir, { dbInspectImage: dockerfileServiceImageRaw("pg") });
    return Effect.gen(function* () {
      const seam = yield* DeclarativeSeam;
      const exit = yield* seam.ensureLocalPostgresImageCurrent.pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips docker container inspect when the stack backend is on", () => {
    const dir = tmp.current;
    const { layer, shadowSpawned } = setup(dir, {
      dbInspectImage: dockerfileServiceImageRaw("pg"),
      stackBackend: true,
    });
    return Effect.gen(function* () {
      const seam = yield* DeclarativeSeam;
      const exit = yield* seam.ensureLocalPostgresImageCurrent.pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(shadowSpawned.some((s) => s.args.includes("inspect"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});
