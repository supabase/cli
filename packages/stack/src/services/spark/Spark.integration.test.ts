import { NodeCrypto, NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { makeStandaloneService } from "../../../tests/standalone-service.ts";
import { makeServiceRecipe } from "../Catalog.ts";

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

/** A statement's status in a dry run; `code` is the SQLSTATE of a refusal when Spark gives one. */
const DryRun = Schema.Struct({
  statuses: Schema.Array(
    Schema.Struct({
      status: Schema.String,
      code: Schema.optionalKey(Schema.NullOr(Schema.String)),
      message: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
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
    "serves a project's migrated tables, and sparkmeta passes Studio's SQL and Spark's errors through",
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
          const metaUrl = `http://127.0.0.1:${metaEndpoint.port}`;
          const sql = (query: string, parameters: ReadonlyArray<unknown> = []) =>
            client
              .execute(
                HttpClientRequest.post(`${metaUrl}/pg/query`).pipe(
                  HttpClientRequest.bodyJsonUnsafe({ query, parameters }),
                ),
              )
              .pipe(
                Effect.flatMap((response) =>
                  Effect.map(response.json, (body) => ({ status: response.status, body })),
                ),
              );

          const catalog = yield* sql("select * from pg_enum");
          expect(catalog).toMatchObject({
            status: 400,
            body: { code: "42P01", message: "no such table: pg_enum", hint: null },
          });
          const doBlock = yield* sql("do $$ begin end $$");
          expect(doBlock).toMatchObject({
            status: 400,
            body: { code: "0A000", message: "DO is not supported" },
          });

          const created = yield* sql("create table public.tags (id bigint primary key, name text)");
          expect(created.status).toBe(201);
          const migrations = yield* fs.readDirectory(path.join(root, "supabase", "migrations"));
          expect(migrations.filter((file) => file.endsWith("_studio.sql"))).toHaveLength(1);

          const inserted = yield* sql(
            "insert into public.tags (id, name) values ($1, $2) returning name",
            [1, "a"],
          );
          expect(inserted).toEqual({ status: 201, body: [{ name: "a" }] });

          const fn =
            "create function public.f() returns int language plpgsql as $$ begin return 1; end $$";
          const [status] = yield* client
            .execute(
              HttpClientRequest.post(
                `${metaUrl}/v1/projects/default/database/migrations?dry_run=true`,
              ).pipe(HttpClientRequest.bodyJsonUnsafe({ query: fn })),
            )
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(DryRun)),
              Effect.map(({ statuses }) => statuses),
            );
          const refused = yield* sql(fn);
          expect(refused).toMatchObject({
            status: 400,
            body: {
              code: status?.code ?? (status?.status === "unsupported" ? "0A000" : "42000"),
              message: status?.message,
              details: expect.stringContaining("CreateFunctionStmt"),
            },
          });

          yield* meta.stop;
          yield* spark.stop;
        }),
      ).pipe(Effect.provide(services)),
    120_000,
  );
});
