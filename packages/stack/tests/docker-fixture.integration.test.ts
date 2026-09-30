import { PgClient } from "@effect/sql-pg";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Context, Effect, FileSystem, Layer, Redacted, Schema, Stream } from "effect";
import { makeService } from "../src/Service.ts";
import { makeDatabase, type BackendEndpoint } from "../src/services/Database.ts";
import { makeDockerDatabaseRoot } from "./docker-fixture.ts";

const marker = Schema.Struct({ backend: Schema.Literal("docker"), volume: Schema.String });
const password = Redacted.make("supabase-test-password");

const query = (endpoint: BackendEndpoint, statement: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(
        PgClient.layer({
          host: endpoint.kind === "unix" ? endpoint.path : endpoint.host,
          port: endpoint.port,
          database: "postgres",
          username: "supabase_admin",
          password,
        }),
      );
      return yield* Context.get(services, PgClient.PgClient).unsafe(statement);
    }),
  );

const volumeExists = Effect.fn("DockerFixture.volumeExists")((volume: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("docker", ["volume", "inspect", volume], {
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(code) !== 0) {
        if (/no such volume|not found/iu.test(stderr)) return false;
        return yield* Effect.die(`Docker volume inspect failed: ${stdout}${stderr}`);
      }
      return true;
    }),
  ),
);

describe("Docker database fixture isolation", { timeout: 180_000 }, () => {
  it.live("isolates equal identities and removes both owned volumes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const firstRoot = yield* makeDockerDatabaseRoot(
          "docker-fixture-first-",
          "docker-fixture-isolation",
        );
        const secondRoot = yield* makeDockerDatabaseRoot(
          "docker-fixture-second-",
          "docker-fixture-isolation",
        );
        const make = (root: string) =>
          makeDatabase({
            stackId: "docker-fixture-isolation",
            instanceId: "database",
            root,
            cacheRoot: `${root}/cache`,
            runtime: "docker",
          });
        const [first, second] = yield* Effect.all([make(firstRoot), make(secondRoot)]);
        const [firstService, secondService] = yield* Effect.all([
          makeService(first.definition, {
            id: "docker-fixture-first",
            config: {
              version: "17",
              databasePassword: password,
              jwtSecret: Redacted.make("fixture-secret-with-at-least-32-chars"),
              jwtExpiry: 3600,
            },
          }),
          makeService(second.definition, {
            id: "docker-fixture-second",
            config: {
              version: "17",
              databasePassword: password,
              jwtSecret: Redacted.make("fixture-secret-with-at-least-32-chars"),
              jwtExpiry: 3600,
            },
          }),
        ]);
        yield* Effect.all([firstService.start, secondService.start], { concurrency: "unbounded" });
        yield* Effect.all([firstService.ready, secondService.ready], { concurrency: "unbounded" });
        const [firstEndpoint, secondEndpoint] = yield* Effect.all([
          first.endpoint,
          second.endpoint,
        ]);
        yield* query(firstEndpoint, "CREATE TABLE fixture_isolation (value text)");
        yield* query(firstEndpoint, "INSERT INTO fixture_isolation VALUES ('first')");
        yield* query(secondEndpoint, "CREATE TABLE fixture_isolation (value text)");
        yield* query(secondEndpoint, "INSERT INTO fixture_isolation VALUES ('second')");
        expect(yield* query(firstEndpoint, "SELECT value FROM fixture_isolation")).toEqual([
          { value: "first" },
        ]);
        expect(yield* query(secondEndpoint, "SELECT value FROM fixture_isolation")).toEqual([
          { value: "second" },
        ]);
        yield* firstService.stop;
        expect(yield* query(secondEndpoint, "SELECT value FROM fixture_isolation")).toEqual([
          { value: "second" },
        ]);
        const markers = yield* Effect.all(
          [firstRoot, secondRoot].map((root) =>
            fs
              .readFileString(`${root}/database/.supabase-database-storage.json`)
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(marker)))),
          ),
        );
        yield* secondService.destroy;
        yield* firstService.destroy;
        return markers.map((entry) => entry.volume);
      }),
    ).pipe(
      Effect.flatMap((volumes) =>
        Effect.forEach(volumes, (volume) =>
          volumeExists(volume).pipe(Effect.map((exists) => ({ volume, exists }))),
        ),
      ),
      Effect.tap((results) =>
        Effect.sync(() => results.forEach(({ exists }) => expect(exists).toBe(false))),
      ),
      Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
    ),
  );
});
