import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import {
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockRuntimeInfo, mockStdin } from "../../../../tests/helpers/mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  YesFlag,
} from "../../../command-internal/global-flags.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { dbConnectionLayer } from "../../../command-internal/db-connection.layer.ts";
import { DebugLogger } from "../../../command-internal/debug-logger.service.ts";
import { DockerRun } from "../../../command-internal/docker-run.service.ts";
import { StackApi, stackApiLayer } from "../../../command-internal/stack-api.ts";
import { stackBackendLayer } from "../../../command-internal/stack-backend.ts";
import { stackCatalogSetupLayer } from "../../../command-internal/stack-catalog-setup.ts";
import { BundledPostgresClient } from "../../../command-internal/bundled-postgres-client.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { migrationSquash } from "./squash.handler.ts";
import type { MigrationSquashFlags } from "./squash.command.ts";

const runtimes = ["native", "docker"] as const;
const liveStackApi = stackApiLayer.pipe(Layer.provide(BunServices.layer));

const flags: MigrationSquashFlags = {
  version: Option.none(),
  dbUrl: Option.none(),
  linked: false,
  local: true,
  password: Option.none(),
  projectRef: Option.none(),
};

const failureMessage = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "";
  const error = Cause.findErrorOption(exit.cause);
  return Option.isSome(error) && error.value instanceof Error
    ? error.value.message
    : String(exit.cause);
};

const testLayer = (root: string) =>
  Layer.mergeAll(
    BunServices.layer,
    FetchHttpClient.layer,
    liveStackApi,
    mockCommandSettings({ workdir: root, supabaseHome: root }),
    mockOutput().layer,
    mockTelemetryStateTracked().layer,
    mockLinkedProjectCacheTracked().layer,
    mockRuntimeInfo(),
    Layer.succeed(CliArgs, { args: [] }),
    Layer.succeed(DbConfigResolver, {
      resolve: () =>
        Effect.succeed({
          conn: {
            host: "127.0.0.1",
            port: 54322,
            user: "postgres",
            password: "postgres",
            database: "postgres",
          },
          isLocal: true,
        }),
      resolvePoolerFallback: () => Effect.succeed(Option.none()),
    }),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(ExperimentalFlag, false),
    Layer.succeed(NetworkIdFlag, Option.none()),
    Layer.succeed(YesFlag, true),
    Layer.succeed(DebugLogger, { debug: () => Effect.void, http: () => Effect.void }),
    Layer.succeed(ProjectRefResolver, {
      resolve: () => Effect.succeed("abcdefghijklmnopqrst"),
      resolveForLink: () => Effect.succeed("abcdefghijklmnopqrst"),
      resolveOptional: () => Effect.succeed(Option.some("abcdefghijklmnopqrst")),
      loadProjectRef: () => Effect.succeed("abcdefghijklmnopqrst"),
      promptProjectRef: () => Effect.succeed("abcdefghijklmnopqrst"),
    }),
    mockStdin(false),
    Layer.succeed(BundledPostgresClient, { run: () => Effect.die("unused") }),
    Layer.succeed(DockerRun, {
      run: () => Effect.die("unused"),
      runCapture: () => Effect.die("unused"),
      runStream: () => Effect.die("unused"),
    }),
    dbConnectionLayer,
    stackCatalogSetupLayer,
    stackBackendLayer("stack"),
  );

describe("managed migration squash", { timeout: 180_000 }, () => {
  for (const runtime of runtimes) {
    it.live(`${runtime} squashes through an owned shadow stack`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { root, first, second } = yield* Effect.provide(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const root = yield* fs.makeTempDirectoryScoped({ prefix: "cli-migration-squash-" });
              const migrations = path.join(root, "supabase", "migrations");
              yield* fs.makeDirectory(migrations, { recursive: true });
              yield* fs.writeFileString(
                path.join(root, "supabase", "config.toml"),
                "[db]\nmajor_version = 17\n[auth]\nenabled = false\n[storage]\nenabled = false\n[realtime]\nenabled = false\n[api]\nenabled = false\n",
              );
              const first = path.join(migrations, "20260919000000_first.sql");
              const second = path.join(migrations, "20260919000001_second.sql");
              yield* fs.writeFileString(first, "create table public.squash_probe(value text);\n");
              yield* fs.writeFileString(
                second,
                "insert into public.squash_probe(value) values ('squashed');\n",
              );
              return { root, first, second };
            }),
            Layer.mergeAll(BunServices.layer, FetchHttpClient.layer),
          );

          yield* Effect.provide(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              const api = yield* StackApi;
              const current = yield* api.create({
                projectRoot: root,
                stateRoot: path.join(root, "stacks"),
                cacheRoot: path.join(root, "cache"),
                runtime,
              });
              yield* Effect.addFinalizer(() =>
                current.destroy.pipe(
                  Effect.catch((cause) =>
                    Effect.die(`failed to destroy test stack ${current.id}: ${cause.message}`),
                  ),
                ),
              );
              const before = yield* current.composition.describe;
              expect(before.members).toHaveLength(0);

              const exit = yield* migrationSquash(flags).pipe(Effect.exit);
              if (Exit.isFailure(exit)) {
                return yield* Effect.die(`managed squash failed: ${failureMessage(exit)}`);
              }

              expect(yield* fs.exists(first)).toBe(false);
              const squashed = yield* fs.readFileString(second);
              expect(squashed).toContain("squash_probe");
              const after = yield* current.composition.describe;
              expect(after.members).toHaveLength(0);
              const saved = yield* api.discover({ stateRoot: path.join(root, "stacks") });
              expect(saved.map(({ definition }) => definition.id)).toEqual([current.id]);
            }),
            testLayer(root),
          );
        }),
      ),
    );
  }
});
