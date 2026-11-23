import { NodeCrypto, NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { makeStandaloneService } from "../../../tests/standalone-service.ts";
import { makeServiceRecipe } from "../Catalog.ts";
import { makeSparkAdmin } from "./Admin.ts";

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

const History = Schema.Array(Schema.Struct({ version: Schema.String }));

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
    "serves a project's migrated tables and runs Studio's pg-meta SQL, schema changes included, as sent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const client = yield* HttpClient.HttpClient;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-spark-serve-" });
          const migrationsDir = path.join(root, "supabase", "migrations");
          yield* fs.makeDirectory(migrationsDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(root, "supabase", "config.toml"),
            'project_id = "spark-test"\n',
          );
          yield* fs.writeFileString(
            path.join(migrationsDir, "20260101000000_notes.sql"),
            "create table public.notes (id bigint primary key, body text not null);\n",
          );
          const recipe = yield* makeServiceRecipe(
            { service: "spark", config: { executable: sparkBinary ?? "", projectRoot: root } },
            options(root),
          );
          const spark = yield* makeStandaloneService(recipe.definition, {
            id: "spark",
            config: recipe.creation,
          });
          yield* spark.start;
          yield* spark.ready;
          const { port } = yield* recipe.endpoint("http");
          const sparkUrl = `http://127.0.0.1:${port}`;
          const serviceRole = {
            apikey: SERVICE_ROLE_KEY,
            authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          };

          const rows = yield* client.get(`${sparkUrl}/rest/v1/notes?select=id`, {
            headers: serviceRole,
          });
          expect(rows.status).toBe(200);
          expect(yield* rows.json).toEqual([]);

          // Studio's self-hosted pg-meta request, which the stack proxy sends from `/pg/query`.
          const sql = (query: string, parameters?: ReadonlyArray<unknown>) =>
            client
              .execute(
                HttpClientRequest.post(`${sparkUrl}/database/query`).pipe(
                  HttpClientRequest.setHeaders({
                    apiKey: SERVICE_ROLE_KEY,
                    "x-connection-encrypted": "encrypted",
                  }),
                  HttpClientRequest.bodyJsonUnsafe(
                    parameters === undefined ? { query } : { query, parameters },
                  ),
                ),
              )
              .pipe(
                Effect.flatMap((response) =>
                  Effect.map(response.json, (body) => ({ status: response.status, body })),
                ),
              );

          expect(yield* sql("select * from pg_enum")).toMatchObject({
            status: 400,
            body: {
              code: "42P01",
              message: "no such table: pg_enum",
              formattedError: expect.stringContaining("no such table: pg_enum"),
            },
          });
          expect(yield* sql("do $$ begin end $$")).toMatchObject({
            status: 400,
            body: { code: "0A000", message: "DO is not supported" },
          });

          expect(
            (yield* sql("create table public.tags (id bigint primary key, name text)")).status,
          ).toBe(201);
          expect(
            yield* sql("insert into public.tags (id, name) values ($1, $2) returning name", [
              1,
              "a",
            ]),
          ).toEqual({ status: 201, body: [{ name: "a" }] });
          const tags = yield* client.get(`${sparkUrl}/rest/v1/tags?select=name`, {
            headers: serviceRole,
          });
          expect(yield* tags.json).toEqual([{ name: "a" }]);
          const admin = makeSparkAdmin(client, sparkUrl, SERVICE_ROLE_KEY);
          const publicDump = yield* admin.dump(["public"]);
          expect(publicDump).toContain("notes");
          expect(publicDump).toContain("tags");
          expect(yield* admin.dump(["other"])).not.toContain("notes");
          expect(yield* fs.readDirectory(migrationsDir)).toEqual(["20260101000000_notes.sql"]);
          const history = yield* client
            .get(`${sparkUrl}/system/v1/migrations`, { headers: serviceRole })
            .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(History)));
          expect(history.map(({ version }) => version)).toEqual(["20260101000000"]);

          yield* spark.stop;
        }),
      ).pipe(Effect.provide(services)),
    120_000,
  );
});
