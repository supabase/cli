import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { FetchHttpClient } from "effect/unstable/http";
import { Effect, FileSystem, Layer, Option } from "effect";

import { mockCommandSettings } from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { runtimeInfoLayer } from "../../../shared/runtime/runtime-info.layer.ts";
import {
  DebugFlag,
  ExperimentalFlag,
  NetworkIdFlag,
} from "../../../command-internal/global-flags.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { DockerRun } from "../../../command-internal/docker-run.service.ts";
import { dbConnectionLayer } from "../../../command-internal/db-connection.layer.ts";
import { parseConnectionString } from "../../../command-internal/db-config.parse.ts";
import { StackApi, stackApiLayer } from "../../../command-internal/stack-api.ts";
import { stackBackendLayer } from "../../../command-internal/stack-backend.ts";
import { pgDeltaNextShadowLayer } from "./pgdelta-next-shadow.layer.ts";
import { PgDeltaNextShadow } from "./pgdelta-next-shadow.service.ts";
import type { DbTomlValues } from "../../../command-internal/db-config.toml-read.ts";

const toml = {
  projectEnv: {},
  envLookup: () => undefined,
  apiSchemas: ["public", "graphql_public"],
  port: 54321,
  shadowPort: 54320,
  password: "postgres",
  poolerConnectionString: Option.none(),
  projectId: Option.some("test"),
  majorVersion: 17,
  orioledbVersion: Option.none(),
  denoVersion: 2,
  pgDelta: {
    enabled: true,
    declarativeSchemaPath: Option.none(),
    formatOptions: Option.none(),
  },
  webhooksEnabled: false,
  baseline: {
    authEnabled: false,
    storageEnabled: false,
    realtimeEnabled: false,
    apiAutoExposeNewTables: Option.none(),
    vaultNames: [],
  },
  migrationsEnabled: true,
  schemaPaths: [],
  schemaPathPatterns: [],
  seed: { enabled: false, sqlPaths: [] },
  vault: [],
  appliedRemote: undefined,
  remoteOverrideKeys: new Set<string>(),
} satisfies DbTomlValues;

const fakeDocker = Layer.succeed(DockerRun, {
  run: () => Effect.die("Docker is not used by the native stack backend"),
  runCapture: () => Effect.die("Docker is not used by the native stack backend"),
  runStream: () => Effect.die("Docker is not used by the native stack backend"),
});

const query = Effect.fn("PgDeltaNextShadowStackTest.query")(function* (
  db: DbConnection["Service"],
  url: string,
  sql: string,
) {
  const connection = parseConnectionString(url);
  if (connection === undefined) return yield* Effect.die("invalid shadow URL");
  const session = yield* db.connect(connection, { isLocal: true, dnsResolver: "native" });
  return yield* session.query(sql);
});

describe("pg-delta next stack shadow provisioning", () => {
  it.live(
    "keeps migrations on the migration shadow and destroys both shadows with the caller scope",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "pgdelta-next-stack-" });
        yield* fs.makeDirectory(`${root}/supabase/migrations`, { recursive: true });
        yield* fs.writeFileString(
          `${root}/supabase/config.toml`,
          'project_id = "test"\n[db]\nmajor_version = 17\n[auth]\nenabled = false\n[storage]\nenabled = false\n[realtime]\nenabled = false\n',
        );
        yield* fs.writeFileString(
          `${root}/supabase/migrations/20260919000000_shadow.sql`,
          "CREATE TABLE public.pgdelta_next_probe(value text); INSERT INTO public.pgdelta_next_probe VALUES ('migration');\n",
        );

        const stateRoot = `${root}/stacks`;
        const settings = mockCommandSettings({ workdir: root, supabaseHome: root });
        const output = mockOutput().layer;
        const apiLayer = stackApiLayer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(BunServices.layer),
        );
        const shadowLayer = pgDeltaNextShadowLayer.pipe(
          Layer.provide(apiLayer),
          Layer.provide(dbConnectionLayer),
          Layer.provide(fakeDocker),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(settings),
          Layer.provide(runtimeInfoLayer),
          Layer.provide(output),
          Layer.provide(Layer.succeed(DebugFlag, false)),
          Layer.provide(Layer.succeed(ExperimentalFlag, false)),
          Layer.provide(Layer.succeed(NetworkIdFlag, Option.none())),
          Layer.provide(Layer.succeed(CliArgs, { args: [] })),
          Layer.provide(BunServices.layer),
        );
        const services = Layer.mergeAll(
          BunServices.layer,
          FetchHttpClient.layer,
          stackBackendLayer("stack"),
          apiLayer,
          dbConnectionLayer,
          fakeDocker,
          settings,
          output,
          Layer.succeed(DebugFlag, false),
          Layer.succeed(ExperimentalFlag, false),
          Layer.succeed(NetworkIdFlag, Option.none()),
          Layer.succeed(CliArgs, { args: [] }),
          shadowLayer,
        );

        const urls = yield* Effect.scoped(
          Effect.gen(function* () {
            const db = yield* DbConnection;
            const shadows = yield* PgDeltaNextShadow;
            const plan = yield* shadows.provisionPlan({
              context: { projectId: "test", cwd: root, denoVersion: 2, projectEnv: {} },
              toml,
              projectRef: "test",
              bypassCache: true,
            });
            expect(plan.migrationsUrl).not.toBe(plan.declarativeUrl);
            expect(
              yield* query(db, plan.migrationsUrl, "SELECT value FROM public.pgdelta_next_probe"),
            ).toEqual([{ value: "migration" }]);
            expect(
              yield* query(
                db,
                plan.declarativeUrl,
                "SELECT to_regclass('public.pgdelta_next_probe') AS table_name",
              ),
            ).toEqual([{ table_name: null }]);
            const api = yield* StackApi;
            expect(yield* api.discover({ stateRoot })).toHaveLength(2);
            return plan;
          }).pipe(Effect.provide(services)),
        );

        expect(urls.migrationsUrl).toMatch(/^postgresql:/);
        const api = yield* Effect.gen(function* () {
          const api = yield* StackApi;
          return yield* api.discover({ stateRoot });
        }).pipe(Effect.provide(services));
        expect(api).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    180_000,
  );
});
