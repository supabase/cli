import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Data,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Ref,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";
import { create, open, type ServiceCreationInput } from "./effect.ts";
import { initialization } from "./Commands.ts";
import { databaseIdentity, recordDatabaseIdentity } from "./internal/database-reuse.ts";
import { readSchemaWriters } from "./internal/schema-writers.ts";
import { makeDatabaseSnapshots } from "./services/DatabaseSnapshot.ts";
import { testArtifactCacheRoot } from "../tests/artifact-cache.ts";
import { selection } from "../tests/pins.ts";
import { destroyTestStack } from "../tests/stack-cleanup.ts";

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);
const jwtSecret = "schema-writers-jwt-secret-with-at-least-32-chars";
const database = {
  service: "database",
  pin: selection.database,
  config: {
    databasePassword: Redacted.make("schema-writers-password"),
    jwtSecret: Redacted.make(jwtSecret),
    jwtExpiry: 3600,
  },
  endpoints: { sql: { port: "auto" } },
} as const satisfies ServiceCreationInput;
const auth = {
  service: "auth",
  pin: selection.auth,
  config: { jwtSecret, jwtExpiry: 3600 },
  endpoints: { http: { port: "auto" } },
} as const satisfies ServiceCreationInput;
const olderAuth = { ...auth, pin: { ...selection.auth, upstreamVersion: "v0.0.1" } } as const;
const migrated = { auth: selection.auth.upstreamVersion };
const unreachableDatabaseUrl = "postgresql://invalid:invalid@127.0.0.1:1/postgres";

const barrierFixture = fileURLToPath(
  new URL("../tests/snapshot-restore-barrier-fixture.ts", import.meta.url),
);

class BarrierError extends Data.TaggedError("BarrierError")<{ readonly message: string }> {}

it.live(
  "refuses an older auth once a newer one migrated the database, until a reset forgets it",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-schema-writers-" });
      const stateRoot = path.join(root, "state");
      const stack = yield* create({
        projectRoot: root,
        stateRoot,
        cacheRoot: testArtifactCacheRoot,
        runtime: "native",
      });
      yield* Effect.acquireUseRelease(
        Effect.succeed(stack),
        (current) =>
          Effect.gen(function* () {
            const members = yield* current.composition.supabase([database, auth], { eager: true });
            const databaseId = members.find(({ service }) => service === "database")?.id;
            const authId = members.find(({ service }) => service === "auth")?.id;
            if (databaseId === undefined || authId === undefined)
              return yield* Effect.die("Composition is missing a member");
            const instanceRoot = path.join(stateRoot, current.id, "data", databaseId);
            const recorded = readSchemaWriters(fs, path, instanceRoot);
            const downgrade = { reuseIds: [databaseId, authId], eager: true };
            const recreate = `supabase stack destroy --stack-id ${current.id}`;

            yield* current.composition.start;
            expect(yield* recorded).toEqual(migrated);
            yield* current.composition.stop;

            const composed = yield* Effect.flip(
              current.composition.supabase([database, olderAuth], downgrade),
            );
            expect(composed.message).toContain("auth v0.0.1 is older than");
            expect(composed.message).toContain(recreate);
            const oneShot = yield* Effect.flip(
              current.commands.run(
                initialization.auth({
                  pin: olderAuth.pin,
                  databaseId,
                  databaseUrl: unreachableDatabaseUrl,
                }),
              ),
            );
            expect(oneShot.message).toContain("auth v0.0.1 is older than");
            expect(oneShot.message).toContain(recreate);
            expect(yield* recorded).toEqual(migrated);

            const target = yield* current.services.get(databaseId);
            if (target.service !== "database")
              return yield* Effect.die("The database member is not a database");
            yield* target.saveSnapshot("auth-migrated", { scope: "instance" });
            yield* target.resetData;
            expect(yield* recorded).toEqual({});

            yield* current.composition.supabase([database, olderAuth], downgrade);
            expect(yield* target.restoreSnapshot("auth-migrated", { scope: "instance" })).toBe(
              true,
            );
            expect(yield* recorded).toEqual(migrated);
            const restored = yield* Effect.flip(
              current.composition.supabase([database, olderAuth], downgrade),
            );
            expect(restored.message).toContain("auth v0.0.1 is older than");

            const newer = '{"auth":"v999.0.0"}';
            yield* current.composition.supabase([database, auth], downgrade);
            yield* fs.writeFileString(path.join(instanceRoot, "schema-writers.json"), newer);
            const started = yield* Effect.flip(current.composition.start);
            const launch = started.outcomes?.find(({ id }) => id === authId);
            expect(launch?.succeeded).toBe(false);
            expect(launch?.error).toContain(
              `auth ${selection.auth.upstreamVersion} is older than v999.0.0`,
            );
            expect(launch?.error).toContain(recreate);
            expect(yield* recorded).toEqual({ auth: "v999.0.0" });
          }),
        destroyTestStack,
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  { timeout: 10 * 60_000 },
);

it.live(
  "keeps every service's version when schema-owning initializations run together",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-schema-writers-concurrent-",
      });
      const stateRoot = path.join(root, "state");
      const stack = yield* create({
        projectRoot: root,
        stateRoot,
        cacheRoot: testArtifactCacheRoot,
        runtime: "native",
      });
      yield* Effect.acquireUseRelease(
        Effect.succeed(stack),
        (current) =>
          Effect.gen(function* () {
            const members = yield* current.composition.supabase([database]);
            const databaseId = members.find(({ service }) => service === "database")?.id;
            if (databaseId === undefined) return yield* Effect.die("Composition has no database");
            const target = { databaseId, databaseUrl: unreachableDatabaseUrl };

            yield* Effect.forEach(
              [
                initialization.auth({ pin: selection.auth, ...target }),
                initialization.storage({
                  pin: selection.storage,
                  filePath: path.join(root, "storage"),
                  ...target,
                }),
                initialization.realtime({ pin: selection.realtime, ...target }),
              ],
              (command) => Effect.exit(current.commands.run(command)),
              { concurrency: "unbounded", discard: true },
            );

            expect(
              yield* readSchemaWriters(
                fs,
                path,
                path.join(stateRoot, current.id, "data", databaseId),
              ),
            ).toEqual({
              auth: selection.auth.upstreamVersion,
              storage: selection.storage.upstreamVersion,
              realtime: selection.realtime.upstreamVersion,
            });
          }),
        destroyTestStack,
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  { timeout: 5 * 60_000 },
);

for (const window of ["before-data", "before-record"] as const) {
  it.live(
    `keeps refusing an older auth when the restoring process is killed ${window}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-schema-writers-kill-" });
        const stateRoot = path.join(root, "state");
        const snapshotCache = path.join(root, "snapshots");
        const stack = yield* create({
          projectRoot: root,
          stateRoot,
          cacheRoot: testArtifactCacheRoot,
          runtime: "native",
        });
        yield* Effect.ensuring(
          Effect.gen(function* () {
            const members = yield* stack.composition.supabase([database, auth]);
            const databaseId = members.find(({ service }) => service === "database")?.id;
            const authId = members.find(({ service }) => service === "auth")?.id;
            if (databaseId === undefined || authId === undefined)
              return yield* Effect.die("Composition is missing a member");
            const instanceRoot = path.join(stateRoot, stack.id, "data", databaseId);
            yield* stack.stop;

            const source = path.join(root, "source");
            yield* fs.makeDirectory(path.join(source, "data"), { recursive: true });
            yield* fs.writeFileString(
              path.join(source, "data", "PG_VERSION"),
              `${selection.database.upstreamVersion.split(".")[0]}\n`,
            );
            yield* recordDatabaseIdentity(
              fs,
              path,
              source,
              databaseIdentity(selection.database.upstreamVersion),
            );
            yield* fs.writeFileString(
              path.join(source, ".supabase-database-ready.json"),
              '{"runtime":"native","profile":"supabase"}',
            );
            yield* fs.writeFileString(
              path.join(source, "schema-writers.json"),
              `{"auth":"${selection.auth.upstreamVersion}"}`,
            );
            const snapshots = yield* makeDatabaseSnapshots({
              instanceRoot: source,
              cacheRoot: snapshotCache,
              runtime: "native",
              pin: selection.database,
            });
            yield* snapshots.saveSnapshot("auth-migrated");

            yield* Effect.scoped(
              Effect.gen(function* () {
                const restoring = yield* spawner.spawn(
                  ChildProcess.make(
                    process.execPath,
                    [barrierFixture, instanceRoot, snapshotCache, "auth-migrated", window],
                    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
                  ),
                );
                const reached = yield* Deferred.make<void>();
                const stderr = yield* Ref.make("");
                yield* restoring.stderr.pipe(
                  Stream.decodeText,
                  Stream.runForEach((chunk) => Ref.update(stderr, (text) => text + chunk)),
                  Effect.forkScoped,
                );
                const output = yield* restoring.stdout.pipe(
                  Stream.decodeText,
                  Stream.splitLines,
                  Stream.tap((line) =>
                    line === "barrier" ? Deferred.succeed(reached, undefined) : Effect.void,
                  ),
                  Stream.runDrain,
                  Effect.forkScoped,
                );
                const failed = (reason: string) =>
                  Ref.get(stderr).pipe(
                    Effect.flatMap((text) =>
                      Effect.fail(new BarrierError({ message: `${reason}: ${text}` })),
                    ),
                  );
                // The fixture announces the boundary itself, right before the real rename, so
                // the kill lands between the restore steps on every run.
                yield* Deferred.await(reached).pipe(
                  Effect.raceFirst(
                    restoring.exitCode.pipe(
                      Effect.flatMap((code) =>
                        failed(`Restore exited before the barrier (${code})`),
                      ),
                    ),
                  ),
                  Effect.timeoutOrElse({
                    duration: "30 seconds",
                    orElse: () => failed("Restore did not reach the barrier"),
                  }),
                );
                yield* Effect.sync(() => process.kill(Number(restoring.pid), "SIGKILL"));
                yield* restoring.exitCode.pipe(Effect.ignore);
                yield* Fiber.join(output);
              }),
            );

            expect(yield* fs.exists(path.join(instanceRoot, "data", "PG_VERSION"))).toBe(
              window === "before-record",
            );
            const reopened = yield* open({
              id: stack.id,
              stateRoot,
              cacheRoot: testArtifactCacheRoot,
            });
            const reuse = { reuseIds: [databaseId, authId] };
            const refused = yield* Effect.flip(
              reopened.composition.supabase([database, olderAuth], reuse),
            );
            expect(refused.message).toContain("auth v0.0.1 is older than");
            expect(refused.message).toContain(`supabase stack destroy --stack-id ${stack.id}`);

            yield* reopened.composition.supabase([database, auth], reuse);
          }),
          destroyTestStack(stack),
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
    { timeout: 3 * 60_000 },
  );
}
