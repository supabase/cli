import { NodeCrypto, NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { HttpClient } from "effect/http";
import { makeStandaloneService } from "../../tests/standalone-service.ts";
import { makeServiceRecipe } from "./Catalog.ts";

/** Spark has no published artifact, so the serving case runs only where a binary is named. */
// oxlint-disable-next-line effecttsgo/process-env -- decides at collection time whether the case runs.
const sparkBinary = process.env.SUPABASE_SPARK_BIN;

/** Spark's own demo key for its default local JWT secret. */
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const options = (root: string, runtime: "native" | "docker" = "native") => ({
  stackId: "catalog-spark",
  instanceId: "spark",
  root,
  cacheRoot: `${root}/cache`,
  runtime,
  claimNativePort: () => Effect.succeed(true),
});

const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NodeHttpClient.layerNodeHttp);

describe("spark recipe", () => {
  it.live("names a missing Spark binary before launching anything", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-spark-missing-" });
        const recipe = yield* makeServiceRecipe(
          {
            service: "spark",
            config: { executable: `${root}/no-such-spark`, projectRoot: root },
          },
          options(root),
        );
        const spark = yield* makeStandaloneService(recipe.definition, {
          id: "spark",
          config: recipe.creation,
        });

        const failure = yield* spark.start.pipe(Effect.flip);

        expect(failure.message).toContain(`spark executable not found: ${root}/no-such-spark`);
      }),
    ).pipe(Effect.provide(services)),
  );

  it.live("refuses a container runtime, since Spark is a host binary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-spark-container-" });
        const recipe = yield* makeServiceRecipe(
          { service: "spark", config: { executable: "/usr/bin/spark", projectRoot: root } },
          options(root, "docker"),
        );
        const spark = yield* makeStandaloneService(recipe.definition, {
          id: "spark",
          config: recipe.creation,
        });

        const failure = yield* spark.start.pipe(Effect.flip);

        expect(failure.message).toContain("needs the native runtime");
      }),
    ).pipe(Effect.provide(services)),
  );

  it.live.runIf(sparkBinary !== undefined)(
    "serves a project's migrated tables, which the meta adapter describes to Studio",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const client = yield* HttpClient.HttpClient;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-spark-serve-" });
          yield* fs.makeDirectory(path.join(root, "supabase", "migrations"), { recursive: true });
          yield* fs.writeFileString(
            path.join(root, "supabase", "config.toml"),
            'project_id = "spark-test"\n',
          );
          yield* fs.writeFileString(
            path.join(root, "supabase", "migrations", "20260101000000_notes.sql"),
            "create table public.notes (id bigint primary key, body text not null);\n",
          );
          const sparkRecipe = yield* makeServiceRecipe(
            { service: "spark", config: { executable: sparkBinary ?? "", projectRoot: root } },
            options(root),
          );
          const spark = yield* makeStandaloneService(sparkRecipe.definition, {
            id: "spark",
            config: sparkRecipe.creation,
          });
          yield* spark.start;
          yield* spark.ready;
          const sparkEndpoint = yield* sparkRecipe.endpoint("http");
          const sparkUrl = `http://127.0.0.1:${sparkEndpoint.port}`;

          const rows = yield* client.get(`${sparkUrl}/rest/v1/notes?select=id`, {
            headers: { apikey: SERVICE_ROLE_KEY, authorization: `Bearer ${SERVICE_ROLE_KEY}` },
          });
          expect(rows.status).toBe(200);
          expect(yield* rows.json).toEqual([]);

          const metaRecipe = yield* makeServiceRecipe(
            {
              service: "sparkmeta",
              config: { sparkUrl, serviceRoleKey: SERVICE_ROLE_KEY, projectRoot: root },
            },
            { ...options(root), instanceId: "sparkmeta" },
          );
          const meta = yield* makeStandaloneService(metaRecipe.definition, {
            id: "sparkmeta",
            config: metaRecipe.creation,
          });
          yield* meta.start;
          yield* meta.ready;
          const metaEndpoint = yield* metaRecipe.endpoint("http");
          const tables = yield* client.get(
            `http://127.0.0.1:${metaEndpoint.port}/pg/tables?included_schemas=public`,
          );
          expect(yield* tables.json).toMatchObject([{ schema: "public", name: "notes" }]);

          yield* meta.stop;
          yield* spark.stop;
        }),
      ).pipe(Effect.provide(services)),
    120_000,
  );
});
