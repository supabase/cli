import { NodeServices } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Ref,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- docker availability probe for optional container cases.
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- isolated artifact cache path.
import { join } from "node:path";
import { EphemeralPostgresError } from "./Errors.ts";
import { createEphemeralPostgres } from "./EphemeralPostgres.ts";
import { listStacks } from "./EffectStack.ts";
import { defaultRuntimeEnvironment, StackRuntimeEnvironment } from "../supervisor/Launcher.ts";
import { checkHostPort } from "../supervisor/HostListener.ts";
import type { StackRuntimePreference } from "./Runtime.ts";

const NATIVE_TIMEOUT_MS = 180_000;
const PASSWORD = "ephemeral-test-password";
const JWT_SECRET = "ephemeral-test-jwt-secret-value";

const dockerAvailable = (): boolean =>
  spawnSync("docker", ["info"], { encoding: "utf8" }).status === 0;

const artifactCacheRoot = join(tmpdir(), "supabase-stack-test-artifacts");

const testEnvironment = (stateRoot: string) =>
  Layer.succeed(StackRuntimeEnvironment, {
    ...defaultRuntimeEnvironment(),
    stateRoot,
    artifactCacheRoot,
  });

const secrets = {
  databasePassword: Redacted.make(PASSWORD),
  jwtSecret: Redacted.make(JWT_SECRET),
};

const query = (url: Redacted.Redacted<string>, statement: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* PgClient.PgClient;
      return yield* client.unsafe(statement);
    }).pipe(Effect.provide(PgClient.layer({ url, connectTimeout: "10 seconds" }))),
  );

const withIsolatedRoot = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({ prefix: "supabase-eph-" });
    yield* Effect.addFinalizer(() => fs.remove(root, { recursive: true }).pipe(Effect.ignore));
    const stateRoot = path.join(root, "managed", "stacks");
    yield* fs.makeDirectory(stateRoot, { recursive: true });
    return yield* effect.pipe(Effect.provide(testEnvironment(stateRoot)));
  });

const writeForeignMarkerTar = (tarPath: string, marker: unknown) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staging = yield* fs.makeTempDirectoryScoped();
      const data = path.join(staging, "data");
      yield* fs.makeDirectory(data);
      yield* fs.writeFileString(
        path.join(data, ".supabase-ephemeral-runtime"),
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- fixture marker bytes packed into a tar.
        JSON.stringify(marker),
      );
      const handle = yield* ChildProcess.make("tar", ["-C", staging, "-cf", tarPath, "data"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = yield* handle.exitCode;
      expect(Number(code)).toBe(0);
    }),
  );

const postmasterPort = (contents: string): number | undefined => {
  const port = Number(contents.split("\n")[3]?.trim());
  return Number.isFinite(port) && port > 0 ? port : undefined;
};

describe("ephemeral Postgres", () => {
  it.live(
    "does not leave postgres listening after an interrupted native start",
    () =>
      withIsolatedRoot(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const env = yield* StackRuntimeEnvironment;
          const ephemeralRoot = path.join(path.dirname(env.stateRoot), "ephemeral-postgres");
          yield* fs.makeDirectory(ephemeralRoot, { recursive: true });
          const spawned = yield* Deferred.make<number>();
          const scan = (): Effect.Effect<void> =>
            Effect.gen(function* () {
              const identities = yield* fs
                .readDirectory(ephemeralRoot)
                .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
              for (const identity of identities) {
                const pidPath = path.join(ephemeralRoot, identity, "data", "postmaster.pid");
                if (!(yield* fs.exists(pidPath).pipe(Effect.orElseSucceed(() => false)))) continue;
                const contents = yield* fs.readFileString(pidPath).pipe(Effect.orElseSucceed(() => ""));
                const port = postmasterPort(contents);
                if (port !== undefined) {
                  yield* Deferred.succeed(spawned, port).pipe(Effect.asVoid);
                  return;
                }
              }
            }).pipe(Effect.asVoid);
          const watchers = yield* Ref.make(new Set<string>());
          const watchDir = (
            dir: string,
            onEvent: Effect.Effect<void>,
          ): Effect.Effect<void> =>
            Effect.gen(function* () {
              const known = yield* Ref.get(watchers);
              if (known.has(dir)) return;
              yield* Ref.update(watchers, (current) => new Set([...current, dir]));
              yield* Effect.forkChild(
                Stream.runForEach(fs.watch(dir), () => onEvent).pipe(Effect.ignore),
              );
            }).pipe(Effect.asVoid);
          const onEvent: Effect.Effect<void> = Effect.suspend(() =>
            Effect.gen(function* () {
              yield* scan();
              const identities = yield* fs
                .readDirectory(ephemeralRoot)
                .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
              for (const identity of identities) {
                const identityDir = path.join(ephemeralRoot, identity);
                yield* watchDir(identityDir, onEvent);
                const dataDir = path.join(identityDir, "data");
                if (yield* fs.exists(dataDir).pipe(Effect.orElseSucceed(() => false)))
                  yield* watchDir(dataDir, onEvent);
              }
            }).pipe(Effect.asVoid),
          );
          yield* watchDir(ephemeralRoot, onEvent);
          const fiber = yield* Effect.forkChild(
            createEphemeralPostgres({ runtime: { kind: "native" }, ...secrets }),
          );
          const port = yield* Deferred.await(spawned);
          yield* Fiber.interrupt(fiber);
          yield* checkHostPort("127.0.0.1", port, "database");
        }),
      ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    NATIVE_TIMEOUT_MS,
  );

  it.live("refuses a snapshot produced by a different runtime before starting Postgres", () =>
    withIsolatedRoot(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tarPath = path.join(yield* fs.makeTempDirectoryScoped(), "foreign.tar");
        yield* writeForeignMarkerTar(tarPath, { kind: "container", engine: "docker" });
        const exit = yield* createEphemeralPostgres({
          runtime: { kind: "native" },
          restoreFrom: tarPath,
          ...secrets,
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        expect(error).toBeInstanceOf(EphemeralPostgresError);
        if (!(error instanceof EphemeralPostgresError)) return;
        expect(error.reason).toBe("restore-mismatch");
      }),
    ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "starts a native cluster, snapshots, restores, and destroys without a stack identity",
    () =>
      withIsolatedRoot(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const exportDir = yield* fs.makeTempDirectoryScoped();
          const tarPath = path.join(exportDir, "baseline.tar");
          const first = yield* createEphemeralPostgres({ runtime: { kind: "native" }, ...secrets });
          const rows = yield* query(
            first.url,
            "SELECT rolname FROM pg_roles WHERE rolname = 'supabase_admin'",
          );
          expect(rows.length).toBeGreaterThan(0);
          expect(first.runtime.kind).toBe("native");
          expect(first.artifactIdentity.startsWith("native:")).toBe(true);
          const listedWhileRunning = yield* listStacks({});
          expect(listedWhileRunning.some((stack) => stack.id === first.artifactIdentity)).toBe(
            false,
          );
          yield* first.stop();
          yield* first.exportPgData(tarPath);
          const exists = yield* fs.exists(tarPath);
          expect(exists).toBe(true);

          const restored = yield* createEphemeralPostgres({
            runtime: { kind: "native" },
            restoreFrom: tarPath,
            ...secrets,
          });
          const restoredRows = yield* query(restored.url, "SELECT current_database() AS name");
          expect(restoredRows).toEqual([{ name: "postgres" }]);
          expect(restored.port).not.toBe(first.port);

          const second = yield* createEphemeralPostgres({
            runtime: { kind: "native" },
            ...secrets,
          });
          expect(second.port).not.toBe(first.port);
          expect(second.port).not.toBe(restored.port);
          yield* query(second.url, "SELECT 1");
        }),
      ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    NATIVE_TIMEOUT_MS,
  );

  it.live.skipIf(!dockerAvailable())(
    "starts a container cluster, snapshots, and restores",
    () =>
      withIsolatedRoot(
        Effect.gen(function* () {
          const runtime: StackRuntimePreference = { kind: "container", engine: "docker" };
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tarPath = path.join(yield* fs.makeTempDirectoryScoped(), "baseline.tar");
          const first = yield* createEphemeralPostgres({ runtime, ...secrets });
          yield* query(first.url, "SELECT 1");
          expect(first.runtime.kind).toBe("container");
          expect(first.artifactIdentity.startsWith("container:docker:")).toBe(true);
          yield* first.stop();
          yield* first.exportPgData(tarPath);
          const restored = yield* createEphemeralPostgres({
            runtime,
            restoreFrom: tarPath,
            ...secrets,
          });
          yield* query(restored.url, "SELECT 1");
          expect(restored.port).not.toBe(first.port);
        }),
      ).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    NATIVE_TIMEOUT_MS,
  );
});
