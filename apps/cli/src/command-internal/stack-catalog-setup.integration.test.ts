import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Redacted, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { tmpdir } from "node:os";
import { create, postgres } from "@supabase/stack/effect";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import { stackCatalogSetupLayer, StackCatalogSetup } from "./stack-catalog-setup.ts";

const cacheRoot = `${tmpdir()}/supabase-stack-artifacts`;
const jwtSecret = "stack-catalog-setup-integration-secret";

describe("stack catalog setup", { timeout: 180_000 }, () => {
  for (const runtime of ["native", "docker"] as const) {
    it.live(`initializes selected database services on a stopped ${runtime} composition`, () => {
      const buildOutput = mockOutput();
      const callOutput = mockOutput();
      return Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: `stack-catalog-${runtime}-` });
          yield* fs.makeDirectory(`${root}/supabase`, { recursive: true });
          yield* fs.writeFileString(
            `${root}/supabase/roles.sql`,
            "CREATE TABLE IF NOT EXISTS public.catalog_overlay(owner uuid REFERENCES auth.users(id), value text NOT NULL);\n",
          );
          const stack = yield* create({
            projectRoot: root,
            stateRoot: `${root}/state`,
            cacheRoot,
            runtime,
          });
          yield* Effect.acquireUseRelease(
            Effect.succeed(stack),
            (stack) =>
              Effect.gen(function* () {
                const members = yield* stack.composition.supabase([
                  {
                    service: "database",
                    config: {
                      version: "17",
                      databasePassword: Redacted.make("postgres"),
                      jwtSecret: Redacted.make(jwtSecret),
                      jwtExpiry: 3600,
                    },
                    endpoints: { sql: { port: "auto" } },
                  },
                  {
                    service: "auth",
                    config: { databaseUrl: "postgresql://placeholder", jwtSecret },
                    endpoints: { http: { port: "auto" } },
                  },
                  {
                    service: "storage",
                    config: {
                      databaseUrl: "postgresql://placeholder",
                      jwtSecret,
                      filePath: `${root}/unused-storage`,
                    },
                    endpoints: { http: { port: "auto" } },
                  },
                  {
                    service: "realtime",
                    config: { databaseUrl: "postgresql://placeholder", jwtSecret },
                    endpoints: { http: { port: "auto" }, rpc: { port: "auto" } },
                  },
                ]);
                const database = members.find((member) => member.service === "database");
                if (database === undefined) return yield* Effect.die("database member missing");
                yield* database.start;
                yield* database.ready;
                const runtimeCredentials = yield* database.credentials({ from: "runtime" });
                const databaseUrl = runtimeCredentials.databaseUrl;
                if (databaseUrl === undefined) return yield* Effect.die("database URL missing");

                const setup = yield* Effect.service(StackCatalogSetup);
                yield* setup
                  .apply({
                    target: {
                      stack,
                      database,
                      databaseServices: ["auth", "storage", "realtime"],
                      jwtSecret,
                    },
                    overlay: {
                      webhooks: "disabled",
                      webhooksEnabled: false,
                      apiAutoExposeNewTables: Option.none(),
                      vault: [],
                      workdir: root,
                      announceRoles: true,
                    },
                  })
                  .pipe(Effect.provide(callOutput.layer));
                expect(callOutput.stderrText).toContain("Seeding globals from roles.sql...");
                const realtime = members.find((member) => member.service === "realtime");
                if (realtime === undefined) return yield* Effect.die("realtime member missing");
                yield* realtime.start;
                yield* realtime.ready;
                yield* realtime.stop;

                const rows: Array<string> = [];
                const errors: Array<string> = [];
                const query = yield* stack.tools.run(postgres.psql({ major: 17 }), {
                  args: ["--dbname", databaseUrl, "-At"],
                  stdin: Stream.make(
                    new TextEncoder().encode(
                      "select coalesce(to_regclass('auth.users')::text,'missing'), coalesce(to_regclass('storage.objects')::text,'missing'), coalesce(to_regclass('realtime.messages')::text,'missing'), coalesce(to_regclass('realtime.subscription')::text,'missing'), coalesce(to_regclass('public.catalog_overlay')::text,'missing');",
                    ),
                  ),
                  stdout: (bytes) => Effect.sync(() => rows.push(new TextDecoder().decode(bytes))),
                  stderr: (bytes) =>
                    Effect.sync(() => errors.push(new TextDecoder().decode(bytes))),
                });
                expect(query.exitCode, errors.join("")).toBe(0);
                expect(rows.join("").trim()).toBe(
                  "users|storage.objects|realtime.messages|realtime.subscription|catalog_overlay",
                );

                const listed = yield* stack.services.list;
                expect(listed.map((instance) => instance.id).sort()).toEqual(
                  members.map((instance) => instance.id).sort(),
                );
                for (const instance of listed) {
                  if (instance.service !== "database")
                    expect((yield* instance.status).lifecycle).toBe("stopped");
                }
              }),
            (stack) => stack.destroy,
          );
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            FetchHttpClient.layer,
            buildOutput.layer,
            stackCatalogSetupLayer,
          ),
        ),
      );
    });
  }
});
