import { NodeHttpClient, NodeServices, NodeSocketServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { discover, type Stack } from "./effect.ts";
import { makeTestStack } from "./testing.ts";
import { postgres } from "./Tools.ts";

const sql = (stack: Stack, databaseUrl: string, command: string) =>
  Effect.gen(function* () {
    const decoder = new TextDecoder();
    let stdout = "";
    let stderr = "";
    const result = yield* stack.tools.run(postgres.psql({ major: 17 }), {
      args: ["--dbname", databaseUrl, "--set", "ON_ERROR_STOP=1", "-tA", "--command", command],
      stdout: (bytes) => Effect.sync(() => (stdout += decoder.decode(bytes))),
      stderr: (bytes) => Effect.sync(() => (stderr += decoder.decode(bytes))),
    });
    if (result.exitCode !== 0) return yield* Effect.die(`psql failed: ${stderr}`);
    return stdout.trim();
  });

const snapshotDescriptors = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(root))) return [];
    const files = yield* fs.readDirectory(root, { recursive: true });
    return files.filter((file) => file.endsWith("descriptor.json"));
  });

it.live(
  "keeps every checkpoint of parallel stacks beyond the snapshot cache bound and removes them on destroy",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateRoot = yield* fs.makeTempDirectoryScoped({ prefix: "stack-testing-state-" });
      const cacheRoot = yield* fs.makeTempDirectoryScoped({ prefix: "stack-testing-cache-" });
      const exercise = (label: string) =>
        Effect.gen(function* () {
          const test = yield* makeTestStack({ runtime: "native", stateRoot, cacheRoot });
          const { databaseUrl } = yield* test.services.database.credentials();
          if (databaseUrl === undefined) return yield* Effect.die("Database URL missing");
          const rows = sql(
            test.stack,
            databaseUrl,
            "SELECT string_agg(value, ',' ORDER BY value) FROM checkpoint_rows",
          );
          yield* sql(test.stack, databaseUrl, "CREATE TABLE checkpoint_rows (value text NOT NULL)");
          for (const step of ["0", "1", "2", "3"]) {
            yield* sql(
              test.stack,
              databaseUrl,
              `INSERT INTO checkpoint_rows VALUES ('${label}${step}')`,
            );
            yield* test.checkpoint(step);
          }

          yield* test.reset("0");
          expect(yield* rows).toBe(`${label}0`);
          yield* test.reset("2");
          expect(yield* rows).toBe(`${label}0,${label}1,${label}2`);
          const unknown = yield* test.reset("unknown").pipe(Effect.flip);
          expect(unknown.message).toContain("the database data was not reset");
          expect(yield* rows).toBe(`${label}0,${label}1,${label}2`);
          expect(yield* snapshotDescriptors(path.join(stateRoot, test.stack.id))).toHaveLength(4);
        }).pipe(Effect.scoped);

      yield* Effect.all([exercise("a"), exercise("b")], { concurrency: "unbounded" });

      expect(yield* discover({ stateRoot })).toEqual([]);
      expect(yield* snapshotDescriptors(stateRoot)).toEqual([]);
      expect(yield* snapshotDescriptors(cacheRoot)).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
    ),
  { timeout: 240_000 },
);

it.live(
  "warns that data may be partially reset when resetData fails before restoring a checkpoint",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-testing-partial-reset-",
      });
      const test = yield* makeTestStack({ runtime: "native", stateRoot });
      yield* test.checkpoint("0");

      const root = path.join(stateRoot, test.stack.id);
      const owners = (yield* fs.readDirectory(root, { recursive: true })).filter((file) =>
        file.endsWith(".supabase-database-owner.json"),
      );
      expect(owners).toHaveLength(1);
      const ownerFile = path.join(root, owners[0]!);
      const originalMarker = yield* fs.readFileString(ownerFile);
      yield* fs.writeFileString(
        ownerFile,
        `{"stackId":"not-this-stack","instanceId":"not-this-instance"}`,
      );

      const failure = yield* test.reset("0").pipe(Effect.flip);
      expect(failure.message).toContain("the database data may have been partially reset");
      expect(failure.message).not.toContain("was reset without restoring checkpoint");

      // Restore the real marker so destroying the stack during test cleanup succeeds.
      yield* fs.writeFileString(ownerFile, originalMarker);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
    ),
  { timeout: 120_000 },
);

it.live(
  "names the failure, service states and owner log, then removes the stack when test startup fails",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateRoot = yield* fs.makeTempDirectoryScoped({ prefix: "stack-testing-failure-" });
      const occupied = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 });
      if (occupied.address._tag !== "TcpAddress") return yield* Effect.die("Expected TCP");
      const port = occupied.address.port;

      const startup = yield* makeTestStack({
        services: [{ service: "mail", endpoints: { http: { port } } }],
        runtime: "native",
        stateRoot,
      }).pipe(Effect.scoped, Effect.exit);

      expect(Exit.isFailure(startup)).toBe(true);
      const failure = Exit.isFailure(startup)
        ? Cause.findErrorOption(startup.cause)
        : Option.none();
      if (Option.isNone(failure)) return yield* Effect.die("Expected a typed startup failure");
      expect(failure.value.operation).toBe("test-startup");
      expect(failure.value.message).toContain(`${port} is already in use`);
      expect(failure.value.message).toContain("Services: none");
      expect(failure.value.message).toMatch(/Owner log: .+\/owner\.log$/);
      expect(yield* discover({ stateRoot })).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
    ),
  { timeout: 120_000 },
);

it.live(
  "closes a test stack that its test already destroyed",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateRoot = yield* fs.makeTempDirectoryScoped({ prefix: "stack-testing-destroyed-" });

      const afterDestroy = yield* Effect.gen(function* () {
        const test = yield* makeTestStack({ services: ["mail"], runtime: "native", stateRoot });
        yield* test.stack.destroy;
        return yield* test.stack.composition.start.pipe(Effect.flip);
      }).pipe(Effect.scoped);

      expect(afterDestroy.reason).toBe("owner-unavailable");
      expect(yield* discover({ stateRoot })).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
    ),
  { timeout: 120_000 },
);

it.live("rejects an unknown SUPABASE_STACK_TEST_RUNTIME before creating a stack", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateRoot = yield* fs.makeTempDirectoryScoped({ prefix: "stack-testing-runtime-" });

    const failure = yield* makeTestStack({ stateRoot }).pipe(
      Effect.scoped,
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ SUPABASE_STACK_TEST_RUNTIME: "vm" })),
      ),
      Effect.flip,
    );

    expect(failure.operation).toBe("test-stack");
    expect(failure.message).toContain("SUPABASE_STACK_TEST_RUNTIME");
    expect(yield* discover({ stateRoot })).toEqual([]);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
  ),
);
