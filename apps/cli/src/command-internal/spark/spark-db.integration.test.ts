import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { mockCommandSettings } from "../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import {
  PgDeltaNextAdapter,
  type PgDeltaNextSparkPlanResult,
} from "../../commands/db/shared/pgdelta-next-adapter.service.ts";
import { sparkDbDiff, sparkDbPush } from "./spark-db.ts";
import { SparkStack } from "./spark-stack.ts";

const connection = { url: "http://spark.test", key: "service-key" };

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const runningSpark = Layer.succeed(SparkStack, {
  connection: Effect.succeed(connection),
  whileStopped: (effect) => effect,
});

const planning = (result: PgDeltaNextSparkPlanResult) =>
  Layer.succeed(PgDeltaNextAdapter, {
    diff: () => Effect.die("unused"),
    exportDeclarativeSchema: () => Effect.die("unused"),
    planDeclarativeSchema: () => Effect.die("unused"),
    captureSnapshot: () => Effect.die("unused"),
    exportSparkSchema: () => Effect.die("unused"),
    planSparkSchema: () => Effect.succeed(result),
  });

/** A project with one declarative schema file and the given migrations. */
const project = (migrations: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-spark-db-" });
    const schemas = path.join(root, "supabase", "schemas", "public");
    const migrationsDir = path.join(root, "supabase", "migrations");
    yield* fs.makeDirectory(schemas, { recursive: true });
    yield* fs.makeDirectory(migrationsDir, { recursive: true });
    yield* fs.writeFileString(path.join(schemas, "notes.sql"), "create table public.notes ();\n");
    for (const [name, sql] of Object.entries(migrations))
      yield* fs.writeFileString(path.join(migrationsDir, name), sql);
    return { root, migrationsDir, fs };
  });

const run = <A, E, R>(
  root: string,
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<PgDeltaNextAdapter | SparkStack | HttpClient.HttpClient>,
) => {
  const output = mockOutput();
  return effect.pipe(
    Effect.provide(Layer.mergeAll(layer, output.layer, mockCommandSettings({ workdir: root }))),
    Effect.exit,
    Effect.map((exit) => ({
      exit,
      stdout: output.rawChunks
        .filter((c) => c.stream === "stdout")
        .map((c) => c.text)
        .join(""),
      stderr: output.rawChunks
        .filter((c) => c.stream === "stderr")
        .map((c) => c.text)
        .join(""),
    })),
  );
};

const unusedHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("unused")),
);

describe("supabase db diff on Spark", () => {
  it.live("writes a proven plan as the named migration and reports the proof", () =>
    Effect.gen(function* () {
      const { root, migrationsDir, fs } = yield* project();
      const sql = "create table public.notes ();\n";

      const result = yield* run(
        root,
        sparkDbDiff("add_notes"),
        Layer.mergeAll(
          runningSpark,
          unusedHttp,
          planning({
            sql,
            diagnostics: [],
            proof: { ok: true, expected: "h1", actual: "h1", diagnostics: [] },
          }),
        ),
      );

      expect(result.exit._tag).toBe("Success");
      expect(result.stderr).toContain("Proof: OK (plan converges to the desired schema, h1)");
      const files = yield* fs.readDirectory(migrationsDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d{14}_add_notes\.sql$/u);
      expect(yield* fs.readFileString(`${migrationsDir}/${files[0]}`)).toBe(sql);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("prints only that nothing changed when the files match Spark", () =>
    Effect.gen(function* () {
      const { root, migrationsDir, fs } = yield* project();

      const result = yield* run(
        root,
        sparkDbDiff("noop"),
        Layer.mergeAll(runningSpark, unusedHttp, planning({ sql: "", diagnostics: [] })),
      );

      expect(result.exit._tag).toBe("Success");
      expect(result.stdout).toBe("No schema changes found\n");
      expect(yield* fs.readDirectory(migrationsDir)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("rejects schema files Spark cannot run, naming the statement, and writes nothing", () =>
    Effect.gen(function* () {
      const { root, migrationsDir, fs } = yield* project();

      const result = yield* run(
        root,
        sparkDbDiff("with_function"),
        Layer.mergeAll(
          runningSpark,
          unusedHttp,
          planning({
            sql: "create table public.notes ();\n",
            diagnostics: [
              {
                severity: "error",
                message: "public/functions.sql:1 CreateFunctionStmt unsupported",
              },
            ],
          }),
        ),
      );

      expect(result.exit._tag).toBe("Failure");
      expect(result.stderr).toContain("public/functions.sql:1 CreateFunctionStmt unsupported");
      expect(yield* fs.readDirectory(migrationsDir)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});

describe("supabase db push on Spark", () => {
  /** Spark's migrations API: one applied version, and dry runs that fail for `failing`. */
  const sparkMigrations = (failing?: string) => {
    const posted: Array<string> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url);
        const raw =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
        const version = String(Reflect.get(Object(decodeJson(raw)), "version") ?? "");
        const body =
          request.method === "GET"
            ? [{ version: "20260101000000" }]
            : version === failing && url.searchParams.has("dry_run")
              ? { ok: false, statuses: [{ line: 1, status: "unsupported", message: "no" }] }
              : { ok: true, statuses: [] };
        if (request.method === "POST")
          posted.push(`${url.search === "" ? "apply" : "dry"} ${version}`);
        return HttpClientResponse.fromWeb(request, Response.json(body));
      }),
    );
    return { posted, layer: Layer.succeed(HttpClient.HttpClient, client) };
  };

  const migrations = {
    "20260101000000_todos.sql": "create table public.todos ();\n",
    "20260201000000_notes.sql": "create table public.notes ();\n",
    "20260301000000_tags.sql": "create table public.tags ();\n",
  };

  it.live("dry-runs every pending migration before applying them in order", () =>
    Effect.gen(function* () {
      const { root } = yield* project(migrations);
      const spark = sparkMigrations();

      const result = yield* run(
        root,
        sparkDbPush,
        Layer.mergeAll(runningSpark, spark.layer, planning({ sql: "", diagnostics: [] })),
      );

      expect(result.exit._tag).toBe("Success");
      expect(spark.posted).toEqual([
        "dry 20260201000000",
        "dry 20260301000000",
        "apply 20260201000000",
        "apply 20260301000000",
      ]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("applies nothing when one pending migration does not run on Spark", () =>
    Effect.gen(function* () {
      const { root } = yield* project(migrations);
      const spark = sparkMigrations("20260301000000");

      const result = yield* run(
        root,
        sparkDbPush,
        Layer.mergeAll(runningSpark, spark.layer, planning({ sql: "", diagnostics: [] })),
      );

      expect(result.exit._tag).toBe("Failure");
      expect(result.stderr).toContain("20260301000000_tags.sql:1: unsupported: no");
      expect(spark.posted.filter((call) => call.startsWith("apply"))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
