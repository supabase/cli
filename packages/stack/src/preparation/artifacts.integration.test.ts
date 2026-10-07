import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Crypto,
  Data,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as Environment from "../namespace/Environment.ts";
import { defaultNativeProcessLauncher, spawnNativeProcess } from "../runtime/NativeProcess.ts";
import { acquireLock, isBusy, takeExclusiveLock } from "../namespace/drivers/Sqlite.ts";
import { ArtifactIntegrityError, PreparationError } from "./Errors.ts";
import { makeArtifactStore, type ArtifactRequest, type ArtifactSource } from "./ArtifactStore.ts";
import { verifySha256 } from "./Integrity.ts";

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);
const archive = new TextEncoder().encode("archive");
const archiveSha256 = "0eb3e36bfb24dcd9bb1d1bece1531216b59539a8fde17ee80224af0653c92aa3";
const request: ArtifactRequest = {
  key: "database/postgres",
  requiredRuntimePaths: ["bin/postgres", "etc/postgres.conf"],
  executablePath: "bin/postgres",
};

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(layer));

const mapMaterializeError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof PreparationError || cause instanceof ArtifactIntegrityError
        ? cause
        : new PreparationError({
            message: `materialization failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
    ),
  );

const sourceWriting = (bytes: Uint8Array = archive): ArtifactSource => ({
  checksum: () => Effect.succeed(archiveSha256),
  materialize: (_request, destination, expectedSha256) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
      yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
      yield* fs.writeFileString(`${destination}/bin/postgres`, "native postgres", { mode: 0o755 });
      yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config", { mode: 0o644 });
      const crypto = yield* Crypto.Crypto;
      yield* verifySha256(bytes, expectedSha256).pipe(Effect.provideService(Crypto.Crypto, crypto));
    }).pipe(mapMaterializeError),
});

/** A second digest, published by `triggerSweep` under a fresh key per call. */
const archiveAlt = new TextEncoder().encode("archive-alt");
const archiveAltSha256 = createHash("sha256").update(archiveAlt).digest("hex");
const sourceWritingAlt = (): ArtifactSource => ({
  checksum: () => Effect.succeed(archiveAltSha256),
  materialize: (_request, destination, expectedSha256) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
      yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
      yield* fs.writeFileString(`${destination}/bin/postgres`, "native postgres alt", {
        mode: 0o755,
      });
      yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config alt", { mode: 0o644 });
      const crypto = yield* Crypto.Crypto;
      yield* verifySha256(archiveAlt, expectedSha256).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
      );
    }).pipe(mapMaterializeError),
});

/** A cache miss under a fresh key: the only event that triggers a retirement sweep. */
const triggerSweep = (root: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const key = `database/postgres-sweep-${yield* crypto.randomUUIDv4}`;
    const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWritingAlt() });
    return yield* store.prepare({ ...request, key });
  });

/** Sets `path`'s mtime 31 days in the past: a legitimate test-only lever on retirement's age fence. */
const ageLockFile = (fs: FileSystem.FileSystem, path: string) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const aged = DateTime.toDate(DateTime.subtract(now, { days: 31 }));
    yield* fs.utimes(path, aged, aged);
  });

/** Matches a staging token's own lock file, or the rollback journal SQLite leaves transiently. */
const isStagingLockFile = (name: string) => /\.lock(-journal)?$/u.test(name);

const digestDirectories = (fs: FileSystem.FileSystem, keyRoot: string) =>
  fs.readDirectory(keyRoot).pipe(
    Effect.orElseSucceed(() => []),
    Effect.map((names) => names.filter((name) => /^[0-9a-f]{64}$/u.test(name))),
  );

const fixturePath = fileURLToPath(
  new URL("../../tests/artifact-store-fixture.ts", import.meta.url),
);

const spawnFixture = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.spawn(
      ChildProcess.make(process.execPath, [fixturePath, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
        forceKillAfter: "1 second",
      }),
    );
  });

const runToCompletion = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Effect.all(
    [
      handle.stdout.pipe(Stream.decodeText, Stream.mkString),
      handle.stderr.pipe(Stream.decodeText, Stream.mkString),
      handle.exitCode,
    ],
    { concurrency: "unbounded" },
  );

/** Reads the fixture's first stdout line without waiting for it to exit: `use`/`stall` block forever. */
const firstLine = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  handle.stdout.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const killAndAwaitExit = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Effect.sync(() => process.kill(Number(handle.pid), "SIGKILL")).pipe(
    Effect.andThen(handle.exitCode.pipe(Effect.ignore)),
  );

describe("verified native artifact preparation", () => {
  it.live("downloads and publishes a content-addressed generation", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-artifact-" });
        const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
        const prepared = yield* store.prepare(request);
        expect(prepared.outcome).toBe("downloaded");
        expect(prepared.path).toBe(`${yield* fs.realPath(root)}/${request.key}/${archiveSha256}`);
        expect(yield* fs.exists(`${prepared.path}/bin/postgres`)).toBe(true);
        expect((yield* fs.stat(prepared.path)).mode & 0o777).toBe(0o755);
        expect((yield* fs.stat(`${prepared.path}/bin/postgres`)).mode & 0o777).toBe(0o755);
        expect((yield* fs.stat(`${prepared.path}/etc/postgres.conf`)).mode & 0o777).toBe(0o644);
        expect(yield* fs.exists(prepared.lockPath)).toBe(true);
      }),
    ),
  );

  it.live.skipIf(process.platform === "win32")(
    "restricts cache directories to their owner while keeping a traverse-only grant",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-stack-artifact-traverse-",
          });
          yield* (yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() })).prepare(
            request,
          );
          yield* fs.chmod(root, 0o755);
          yield* fs.chmod(`${root}/database`, 0o755);

          const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
          expect((yield* store.prepare(request)).outcome).toBe("cached");

          expect((yield* fs.stat(root)).mode & 0o777).toBe(0o701);
          expect((yield* fs.stat(`${root}/database`)).mode & 0o777).toBe(0o701);
        }),
      ),
  );

  it.live("returns a verified cache hit without invoking the source again", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-cache-",
        });
        let checksumCalls = 0;
        let materializeCalls = 0;
        const source: ArtifactSource = {
          checksum: () =>
            Effect.sync(() => {
              checksumCalls += 1;
              return archiveSha256;
            }),
          materialize: (entry, destination) =>
            Effect.sync(() => {
              materializeCalls += 1;
              return entry;
            }).pipe(Effect.andThen(sourceWriting().materialize(entry, destination, archiveSha256))),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const first = yield* store.prepare(request);
        const second = yield* store.prepare(request);
        expect(first.outcome).toBe("downloaded");
        expect(second.outcome).toBe("cached");
        expect(second.path).toBe(first.path);
        expect(checksumCalls).toBe(2);
        expect(materializeCalls).toBe(1);
      }),
    ),
  );

  it.live(
    "serves a newly required path already present in the published tree without redownloading",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-stack-artifact-paths-expand-",
          });
          let materializeCalls = 0;
          const source: ArtifactSource = {
            checksum: () => Effect.succeed(archiveSha256),
            materialize: (entry, destination) =>
              Effect.sync(() => {
                materializeCalls += 1;
                return entry;
              }).pipe(
                Effect.andThen(sourceWriting().materialize(entry, destination, archiveSha256)),
              ),
          };
          const store = yield* makeArtifactStore({ cacheRoot: root, source });
          const narrow: ArtifactRequest = { ...request, requiredRuntimePaths: ["bin/postgres"] };
          const first = yield* store.prepare(narrow);
          const publishedIno = (yield* fs.stat(first.path)).ino;
          const second = yield* store.prepare(request);
          const stillPublishedIno = (yield* fs.stat(second.path)).ino;
          expect(first.outcome).toBe("downloaded");
          expect(second.outcome).toBe("cached");
          expect(second.path).toBe(first.path);
          expect(stillPublishedIno).toEqual(publishedIno);
          expect(second.requiredRuntimePaths).toEqual([...request.requiredRuntimePaths]);
          expect(materializeCalls).toBe(1);
          expect(yield* fs.readFileString(`${second.path}/etc/postgres.conf`)).toBe("config");
        }),
      ),
  );

  it.live("rejects a required path whose basic kind changes on a cache hit", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-cache-kind-",
        });
        const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
        const published = yield* store.prepare(request);
        yield* fs.remove(`${published.path}/bin/postgres`);
        yield* fs.makeDirectory(`${published.path}/bin/postgres`);

        const exit = yield* store.prepare(request).pipe(Effect.exit);

        expect(errorOf(exit)).toBeInstanceOf(ArtifactIntegrityError);
      }),
    ),
  );

  it.live("rejects a cache-hit symlink that escapes the artifact root", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-cache-link-escape-",
        });
        const outside = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-cache-link-outside-",
        });
        const outsideExecutable = `${outside}/postgres`;
        yield* fs.writeFileString(outsideExecutable, "outside");
        const symlinkRequest: ArtifactRequest = { ...request, key: "database/postgres-cache-link" };
        const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
        const published = yield* store.prepare(symlinkRequest);
        yield* fs.remove(`${published.path}/bin/postgres`);
        yield* fs.symlink(outsideExecutable, `${published.path}/bin/postgres`);

        const exit = yield* store.prepare(symlinkRequest).pipe(Effect.exit);

        expect(errorOf(exit)).toBeInstanceOf(ArtifactIntegrityError);
      }),
    ),
  );

  it.live("rejects a checksum mismatch and leaves no generation or staging behind", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-integrity-",
        });
        const store = yield* makeArtifactStore({
          cacheRoot: root,
          source: sourceWriting(new TextEncoder().encode("tampered")),
        });
        const exit = yield* store.prepare(request).pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(ArtifactIntegrityError);
        expect(yield* digestDirectories(fs, `${root}/${request.key}`)).toEqual([]);
        const staging = yield* fs
          .readDirectory(`${root}/${request.key}/.staging`)
          .pipe(Effect.orElseSucceed(() => []));
        expect(staging).toEqual([]);
      }),
    ),
  );

  it.live("rejects an executable path that resolves to a directory", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-executable-directory-",
        });
        const source: ArtifactSource = {
          checksum: () => Effect.succeed(archiveSha256),
          materialize: (_entry, destination) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              yield* fs.makeDirectory(`${destination}/bin/postgres`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
              yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config");
            }).pipe(mapMaterializeError),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const exit = yield* store.prepare(request).pipe(Effect.exit);

        expect(errorOf(exit)).toBeInstanceOf(ArtifactIntegrityError);
        expect(yield* digestDirectories(fs, `${root}/${request.key}`)).toEqual([]);
      }),
    ),
  );

  it.live("accepts an internal symlink to an executable in the artifact root", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-internal-link-",
        });
        const source: ArtifactSource = {
          checksum: () => Effect.succeed(archiveSha256),
          materialize: (_entry, destination) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
              yield* fs.writeFileString(`${destination}/bin/postgres.real`, "native postgres", {
                mode: 0o755,
              });
              yield* fs.symlink("postgres.real", `${destination}/bin/postgres`);
              yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config", {
                mode: 0o644,
              });
            }).pipe(mapMaterializeError),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const prepared = yield* store.prepare(request);

        expect(prepared.outcome).toBe("downloaded");
        expect(yield* fs.readLink(`${prepared.path}/bin/postgres`)).toBe("postgres.real");
        expect((yield* fs.stat(`${prepared.path}/bin/postgres`)).mode & 0o111).not.toBe(0);
      }),
    ),
  );

  it.live("rejects a required path symlink that escapes the artifact root", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-link-escape-",
        });
        const outside = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-link-outside-",
        });
        const outsideExecutable = `${outside}/postgres`;
        yield* fs.writeFileString(outsideExecutable, "outside");
        const source: ArtifactSource = {
          checksum: () => Effect.succeed(archiveSha256),
          materialize: (_entry, destination) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
              yield* fs.symlink(outsideExecutable, `${destination}/bin/postgres`);
              yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config");
            }).pipe(mapMaterializeError),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const exit = yield* store.prepare(request).pipe(Effect.exit);

        expect(errorOf(exit)).toBeInstanceOf(ArtifactIntegrityError);
        expect(yield* fs.exists(outsideExecutable)).toBe(true);
        expect(yield* digestDirectories(fs, `${root}/${request.key}`)).toEqual([]);
      }),
    ),
  );

  it.live("cancels caller-owned preparation when the caller is interrupted", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-cancel-",
        });
        const started = yield* Deferred.make<void>();
        const source: ArtifactSource = {
          checksum: () => Effect.succeed(archiveSha256),
          materialize: (_entry, destination) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              yield* fs.writeFileString(`${destination}/partial`, "partial");
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }).pipe(mapMaterializeError),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const preparation = yield* Effect.forkChild(store.prepare(request));
        yield* Deferred.await(started);
        yield* Fiber.interrupt(preparation);
        expect(yield* digestDirectories(fs, `${root}/${request.key}`)).toEqual([]);
      }),
    ),
  );

  it.live("allows separate stores to duplicate work and converge on one published generation", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-converge-",
        });
        const firstStarted = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        const source: ArtifactSource = {
          checksum: () => Effect.succeed(archiveSha256),
          materialize: (_entry, destination) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              calls += 1;
              yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
              yield* fs.writeFileString(`${destination}/bin/postgres`, "native postgres", {
                mode: 0o755,
              });
              yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config", {
                mode: 0o644,
              });
              yield* calls === 1
                ? Deferred.succeed(firstStarted, undefined)
                : Deferred.succeed(secondStarted, undefined);
              yield* Deferred.await(release);
            }).pipe(mapMaterializeError),
        };
        const firstStore = yield* makeArtifactStore({ cacheRoot: root, source });
        const secondStore = yield* makeArtifactStore({ cacheRoot: root, source });
        const first = yield* Effect.forkChild(firstStore.prepare(request));
        yield* Deferred.await(firstStarted);
        const second = yield* Effect.forkChild(secondStore.prepare(request));
        yield* Deferred.await(secondStarted);
        yield* Deferred.succeed(release, undefined);
        const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
        expect(calls).toBe(2);
        expect(results[0].path).toBe(results[1].path);
        expect(yield* fs.exists(`${results[0].path}/bin/postgres`)).toBe(true);
        const staging = yield* fs
          .readDirectory(`${root}/${request.key}/.staging`)
          .pipe(Effect.orElseSucceed(() => []));
        expect(staging).toEqual([]);
      }),
    ),
  );

  it.live("rejects traversal in keys and required runtime paths before touching the source", () =>
    withPlatform(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-path-",
        });
        let called = false;
        const source: ArtifactSource = {
          checksum: () => Effect.succeed(archiveSha256),
          materialize: () => Effect.sync(() => (called = true)),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const keyExit = yield* store.prepare({ ...request, key: "../escape" }).pipe(Effect.exit);
        const pathExit = yield* store
          .prepare({ ...request, requiredRuntimePaths: ["bin/../escape"] })
          .pipe(Effect.exit);
        expect(errorOf(keyExit)).toBeInstanceOf(PreparationError);
        expect(errorOf(pathExit)).toBeInstanceOf(PreparationError);
        expect(called).toBe(false);
      }),
    ),
  );

  it.live("rejects a symlinked cache parent before invoking the source", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-artifact-link-" });
        const outside = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-outside-",
        });
        yield* fs.symlink(outside, `${root}/nested`);
        let called = false;
        const source: ArtifactSource = {
          checksum: () => Effect.succeed(archiveSha256),
          materialize: () => Effect.sync(() => (called = true)),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const exit = yield* store.prepare({ ...request, key: "nested/postgres" }).pipe(Effect.exit);

        expect(errorOf(exit)).toBeInstanceOf(PreparationError);
        expect(called).toBe(false);
        expect(yield* fs.exists(`${outside}/postgres`)).toBe(false);
      }),
    ),
  );
});

describe("a required path missing from the archive", () => {
  const narrowSource = (): ArtifactSource => ({
    checksum: () => Effect.succeed(archiveSha256),
    materialize: (_request, destination, expectedSha256) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
        yield* fs.writeFileString(`${destination}/bin/postgres`, "native postgres", {
          mode: 0o755,
        });
        const crypto = yield* Crypto.Crypto;
        yield* verifySha256(archive, expectedSha256).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
        );
      }).pipe(mapMaterializeError),
  });

  it.live("fails with a typed error on a cold cache, and leaves the cache unchanged", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-missing-cold-",
        });
        const key = "database/postgres-missing-cold";
        const store = yield* makeArtifactStore({ cacheRoot: root, source: narrowSource() });
        const wideRequest: ArtifactRequest = { ...request, key };
        const exit = yield* store.prepare(wideRequest).pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(ArtifactIntegrityError);
        expect(yield* digestDirectories(fs, `${root}/${key}`)).toEqual([]);
      }),
    ),
  );

  it.live("fails with a typed error on a warm cache, and leaves the cache unchanged", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-missing-warm-",
        });
        const key = "database/postgres-missing-warm";
        const store = yield* makeArtifactStore({ cacheRoot: root, source: narrowSource() });
        const narrowRequest: ArtifactRequest = {
          ...request,
          key,
          requiredRuntimePaths: ["bin/postgres"],
        };
        const published = yield* store.prepare(narrowRequest);
        expect(published.outcome).toBe("downloaded");

        const wideRequest: ArtifactRequest = { ...request, key };
        const exit = yield* store.prepare(wideRequest).pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(ArtifactIntegrityError);
        expect(yield* digestDirectories(fs, `${root}/${key}`)).toEqual([archiveSha256]);
        expect(yield* fs.exists(published.path)).toBe(true);
      }),
    ),
  );
});

describe("concurrent preparers across processes", () => {
  it.live(
    "both succeed, exactly one generation is published, and no staging is left",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-stack-artifact-cross-process-",
          });
          const key = "database/postgres-cross-process";
          const handles = yield* Effect.all(
            [spawnFixture(["prepare", root, key]), spawnFixture(["prepare", root, key])],
            { concurrency: "unbounded" },
          );
          const results = yield* Effect.all(handles.map(runToCompletion), {
            concurrency: "unbounded",
          });
          const parsed = results.map(([stdout, stderr, exitCode]) => {
            expect(Number(exitCode), stderr).toBe(0);
            const match = /prepared:(\w+):(.+):([0-9a-f]+)/.exec(stdout.trim());
            if (match === null) throw new Error(`Unparseable fixture output: ${stdout}`);
            return { outcome: match[1], path: match[2], sha256: match[3] };
          });
          expect(parsed[0]?.path).toBe(parsed[1]?.path);
          expect(parsed[0]?.sha256).toBe(parsed[1]?.sha256);
          const staging = yield* fs
            .readDirectory(`${root}/${key}/.staging`)
            .pipe(Effect.orElseSucceed(() => []));
          expect(staging).toEqual([]);
        }),
      ),
    20_000,
  );
});

describe("lock-guarded staging", () => {
  it.live(
    "reaps a SIGKILLed preparer's staging directory on the next preparer, which publishes normally",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-stack-artifact-sigkill-reap-",
          });
          const key = "database/postgres-sigkill-reap";
          const handle = yield* spawnFixture(["stall", root, key]);
          yield* firstLine(handle);
          const stagingRoot = `${root}/${key}/.staging`;
          const tokensBefore = (yield* fs.readDirectory(stagingRoot)).filter(
            (name) => !isStagingLockFile(name),
          );
          expect(tokensBefore).toHaveLength(1);

          yield* killAndAwaitExit(handle);

          const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
          const prepared = yield* store.prepare({ ...request, key });
          expect(prepared.outcome).toBe("downloaded");
          const tokensAfter = (yield* fs.readDirectory(stagingRoot)).filter(
            (name) => !isStagingLockFile(name),
          );
          expect(tokensAfter).toHaveLength(0);
        }),
      ),
    20_000,
  );

  it.live(
    "reaps a crashed preparer's orphan staging under a published key when a miss runs under another key",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-stack-artifact-orphan-reap-",
          });
          const key = "database/postgres-orphan-reap";
          const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
          const published = yield* store.prepare({ ...request, key });
          const orphan = `${root}/${key}/.staging/crashed-token`;
          yield* fs.makeDirectory(`${orphan}/content`, { recursive: true });
          yield* fs.writeFileString(`${orphan}/content/partial`, "partial download");

          const hit = yield* store.prepare({ ...request, key });
          expect(hit.outcome).toBe("cached");
          expect(yield* fs.exists(orphan)).toBe(true);

          yield* triggerSweep(root);

          expect(yield* fs.exists(orphan)).toBe(false);
          expect(yield* fs.exists(published.path)).toBe(true);
        }),
      ),
    20_000,
  );

  it.live.skipIf(process.platform === "win32")(
    "never follows a symlinked staging root or cache subdirectory out of the cache",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-stack-artifact-sweep-link-",
          });
          const outside = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-stack-artifact-sweep-outside-",
          });
          const key = "database/postgres-sweep-link";
          const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
          yield* store.prepare({ ...request, key });
          yield* fs.makeDirectory(`${outside}/token`, { recursive: true });
          yield* fs.writeFileString(`${outside}/token/precious`, "keep");
          yield* fs.writeFileString(`${outside}/precious`, "keep");
          yield* fs.remove(`${root}/${key}/.staging`, { recursive: true, force: true });
          yield* fs.symlink(outside, `${root}/${key}/.staging`);
          yield* fs.symlink(outside, `${root}/linked-subdir`);

          yield* triggerSweep(root);

          expect(yield* fs.exists(`${outside}/token/precious`)).toBe(true);
          expect(yield* fs.exists(`${outside}/precious`)).toBe(true);
        }),
      ),
    20_000,
  );

  it.live(
    "leaves a staging lock file that has no directory yet for the preparer that is about to take it",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-stack-artifact-opening-lock-",
          });
          const key = "database/postgres-opening-lock";
          const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
          yield* store.prepare({ ...request, key });
          const openingLock = `${root}/${key}/.staging/opening-token.lock`;
          yield* fs.writeFile(openingLock, new Uint8Array());

          yield* triggerSweep(root);

          expect(yield* fs.exists(openingLock)).toBe(true);
        }),
      ),
    20_000,
  );

  it.live(
    "never touches a live preparer's staging directory while another preparer runs",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-stack-artifact-live-stage-",
          });
          const key = "database/postgres-live-stage";
          const handle = yield* spawnFixture(["stall", root, key]);
          yield* firstLine(handle);
          const stagingRoot = `${root}/${key}/.staging`;
          const tokensBefore = (yield* fs.readDirectory(stagingRoot)).filter(
            (name) => !isStagingLockFile(name),
          );
          expect(tokensBefore).toHaveLength(1);
          const liveToken = tokensBefore[0];
          if (liveToken === undefined) throw new Error("No live staging token found");

          const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
          const prepared = yield* store.prepare({ ...request, key });
          expect(prepared.outcome).toBe("downloaded");

          const tokensAfter = yield* fs.readDirectory(stagingRoot);
          expect(tokensAfter).toEqual(expect.arrayContaining([liveToken, `${liveToken}.lock`]));
          expect(yield* fs.exists(`${stagingRoot}/${liveToken}/content`)).toBe(true);

          yield* killAndAwaitExit(handle);
        }),
      ),
    20_000,
  );
});

describe("pins", () => {
  it.live(
    "keeps a generation pinned for one in-process consumer while another releases, and retires it only once both are gone",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-stack-artifact-pin-inprocess-",
          });
          const key = "database/postgres-pin-inprocess";
          const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });

          const firstScope = yield* Scope.fork(yield* Scope.Scope, "sequential");
          const firstUse = yield* store.use({ ...request, key }).pipe(Scope.provide(firstScope));
          const secondScope = yield* Scope.fork(yield* Scope.Scope, "sequential");
          const secondUse = yield* store.use({ ...request, key }).pipe(Scope.provide(secondScope));
          expect(firstUse.path).toBe(secondUse.path);

          yield* ageLockFile(fs, firstUse.lockPath);

          // Sweeping while both consumers hold the pin: busy against this process's own open
          // connection, so the stale generation survives untouched.
          yield* triggerSweep(root);
          expect(yield* fs.exists(firstUse.path)).toBe(true);

          yield* Scope.close(firstScope, Exit.void);
          yield* triggerSweep(root);
          expect(yield* fs.exists(firstUse.path)).toBe(true);

          yield* Scope.close(secondScope, Exit.void);
          yield* triggerSweep(root);
          expect(yield* fs.exists(firstUse.path)).toBe(false);
          expect(yield* fs.exists(firstUse.lockPath)).toBe(true);
        }),
      ),
  );

  it.live(
    "a running native workload's generation survives a concurrent retirement sweep, across processes, until it releases",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-stack-artifact-pin-cross-process-",
          });
          const key = "database/postgres-pin-cross-process";
          const handle = yield* spawnFixture(["use", root, key]);
          const line = yield* firstLine(handle);
          const match = /^used:(\w+):(.+):(.+)$/.exec(line);
          if (match === null) throw new Error(`Unparseable fixture output: ${line}`);
          const generationPath = match[2];
          const lockPath = match[3];
          if (generationPath === undefined || lockPath === undefined)
            throw new Error(`Unparseable fixture output: ${line}`);

          yield* ageLockFile(fs, lockPath);
          yield* triggerSweep(root);
          expect(yield* fs.exists(generationPath)).toBe(true);

          yield* killAndAwaitExit(handle);
          yield* ageLockFile(fs, lockPath);
          yield* triggerSweep(root);
          expect(yield* fs.exists(generationPath)).toBe(false);
          expect(yield* fs.exists(lockPath)).toBe(true);
        }),
      ),
    20_000,
  );

  it.live("a retirement sweep that runs between prepare and use cannot break the launch", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-sweep-between-",
        });
        const key = "database/postgres-sweep-between";
        const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
        const prepared = yield* store.prepare({ ...request, key });
        expect(prepared.outcome).toBe("downloaded");

        // Ages the generation past the retention window: ahead-of-time `prepare` only pins
        // itself for its own duration (see `ArtifactStore.prepare`), so by now it is unpinned
        // and genuinely eligible for retirement, unlike the pinned scenarios covered above.
        yield* ageLockFile(fs, prepared.lockPath);

        // A cache miss under another key forces a sweep as a side effect.
        yield* triggerSweep(root);
        expect(yield* fs.exists(prepared.path)).toBe(false);
        expect(yield* fs.exists(prepared.lockPath)).toBe(true);

        // `use` transparently re-prepares the now-retired generation instead of failing the
        // launch, publishing it fresh again at the same content-addressed path.
        const used = yield* Effect.scoped(store.use({ ...request, key }));
        expect(used.outcome).toBe("downloaded");
        expect(used.path).toBe(prepared.path);
        expect(yield* fs.exists(`${used.path}/bin/postgres`)).toBe(true);
      }),
    ),
  );

  it.live("a consumer pins a generation while its retirement is still deleting the old copy", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-retire-delete-",
        });
        const key = "database/postgres-retire-delete";
        const setupStore = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
        const prepared = yield* setupStore.prepare({ ...request, key });
        yield* ageLockFile(fs, prepared.lockPath);
        const keyRoot = path.dirname(prepared.path);

        const deleteStarted = yield* Deferred.make<void>();
        const releaseDelete = yield* Deferred.make<void>();
        const sweepingStore = yield* makeArtifactStore({
          cacheRoot: root,
          source: sourceWritingAlt(),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            remove: (...args: Parameters<typeof fs.remove>) =>
              args[0].startsWith(`${keyRoot}/.staging/`) && !isStagingLockFile(args[0])
                ? Deferred.succeed(deleteStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseDelete)),
                    Effect.andThen(fs.remove(...args)),
                  )
                : fs.remove(...args),
          }),
        );
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseDelete, undefined));

        const sweepFiber = yield* sweepingStore
          .prepare({ ...request, key: "database/postgres-retire-delete-trigger" })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(deleteStarted);
        expect(yield* digestDirectories(fs, keyRoot)).toEqual([]);

        const consumerStore = yield* makeArtifactStore({
          cacheRoot: root,
          source: sourceWriting(),
        });
        const used = yield* Effect.scoped(consumerStore.use({ ...request, key }));
        expect(used.path).toBe(prepared.path);
        expect(yield* fs.exists(`${used.path}/bin/postgres`)).toBe(true);

        yield* Deferred.succeed(releaseDelete, undefined);
        yield* Fiber.join(sweepFiber);
        const leftovers = yield* fs
          .readDirectory(`${keyRoot}/.staging`)
          .pipe(Effect.map((names) => names.filter((name) => !isStagingLockFile(name))));
        expect(leftovers).toEqual([]);
      }),
    ),
  );

  it.live(
    "a sweep retires an aged unpinned generation and spares an aged one this process pins",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-stack-artifact-sweep-pinned-",
          });
          const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
          const pinned = yield* Effect.scoped(
            Effect.gen(function* () {
              const pinnedUse = yield* store.use({
                ...request,
                key: "database/postgres-aged-pinned",
              });
              const unpinned = yield* store.prepare({
                ...request,
                key: "database/postgres-aged-unpinned",
              });
              yield* ageLockFile(fs, pinnedUse.lockPath);
              yield* ageLockFile(fs, unpinned.lockPath);

              yield* triggerSweep(root);

              expect(yield* fs.exists(unpinned.path)).toBe(false);
              expect(yield* fs.exists(pinnedUse.path)).toBe(true);
              return pinnedUse;
            }),
          );
          expect(yield* fs.exists(pinned.path)).toBe(true);
        }),
      ),
  );

  it.live("a cache hit leaves aged unpinned generations alone until the next miss", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-hit-no-sweep-",
        });
        const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
        const warm = yield* store.prepare({ ...request, key: "database/postgres-warm" });
        const stale = yield* store.prepare({ ...request, key: "database/postgres-stale" });
        yield* ageLockFile(fs, stale.lockPath);

        const hit = yield* store.prepare({ ...request, key: "database/postgres-warm" });
        expect(hit.outcome).toBe("cached");
        expect(hit.path).toBe(warm.path);
        expect(yield* fs.exists(stale.path)).toBe(true);

        yield* triggerSweep(root);
        expect(yield* fs.exists(stale.path)).toBe(false);
      }),
    ),
  );

  it.live(
    "a fresh pin never fails busy against a same-process retirement sweep triggered through the real store",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-stack-artifact-pin-sweep-race-",
          });
          const key = "database/postgres-pin-sweep-race";

          const setupStore = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
          const prepared = yield* setupStore.prepare({ ...request, key });
          // Idle and past the retention window: ahead-of-time `prepare` only pins itself for its
          // own duration (see `ArtifactStore.prepare`), so by now nothing in this process still
          // pins it, making it a legitimate, un-pinned sweep target.
          yield* ageLockFile(fs, prepared.lockPath);
          const keyRoot = path.dirname(prepared.path);

          // Gates the sweep right after it opens its own connection on the target's lock path
          // (inside `acquireLock`/`takeExclusiveLock`, just before `retireGeneration`'
          // `fs.stat` call), holding it open across a real async gap under full test control.
          const sweepIsHolding = yield* Deferred.make<void>();
          const releaseSweep = yield* Deferred.make<void>();
          const sweepStore = yield* makeArtifactStore({
            cacheRoot: root,
            source: sourceWritingAlt(),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              stat: (...args: Parameters<typeof fs.stat>) =>
                args[0] === prepared.lockPath
                  ? Deferred.succeed(sweepIsHolding, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseSweep)),
                      Effect.andThen(fs.stat(...args)),
                    )
                  : fs.stat(...args),
            }),
          );

          // Gates the fresh `use` right before it calls `Pin.pin`, once it has resolved the same
          // generation and confirmed the key directory (the step immediately preceding the pin).
          const freshPinApproaching = yield* Deferred.make<void>();
          const letFreshPinProceed = yield* Deferred.make<void>();
          const freshPinStore = yield* makeArtifactStore({
            cacheRoot: root,
            source: sourceWriting(),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              realPath: (...args: Parameters<typeof fs.realPath>) =>
                args[0] === keyRoot
                  ? Deferred.succeed(freshPinApproaching, undefined).pipe(
                      Effect.andThen(Deferred.await(letFreshPinProceed)),
                      Effect.andThen(fs.realPath(...args)),
                    )
                  : fs.realPath(...args),
            }),
          );

          // A failed assertion below must not leave either fiber parked on its gate forever.
          yield* Effect.addFinalizer(() =>
            Effect.all([
              Deferred.succeed(releaseSweep, undefined),
              Deferred.succeed(letFreshPinProceed, undefined),
            ]),
          );

          const sweepFiber = yield* sweepStore
            .prepare({ ...request, key })
            .pipe(Effect.exit, Effect.forkScoped);
          yield* Deferred.await(sweepIsHolding);

          const freshPinFiber = yield* Effect.scoped(freshPinStore.use({ ...request, key })).pipe(
            Effect.exit,
            Effect.forkScoped,
          );
          yield* Deferred.await(freshPinApproaching);

          // Releases the fresh pin into its own `Pin.pin` call first, while the sweep still holds
          // the identical path open, then lets the sweep finish: this is the exact collision an
          // unsynchronized sweep would lose.
          yield* Deferred.succeed(letFreshPinProceed, undefined);
          yield* Deferred.succeed(releaseSweep, undefined);

          const sweepExit = yield* Fiber.join(sweepFiber);
          const freshPinExit = yield* Fiber.join(freshPinFiber);
          const message = (exit: Exit.Exit<unknown, unknown>) =>
            Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
          expect(Exit.isSuccess(sweepExit), message(sweepExit)).toBe(true);
          expect(Exit.isSuccess(freshPinExit), message(freshPinExit)).toBe(true);
        }),
      ),
  );

  it.live(
    "the native launcher holds its own pin independent of the owner, releasing it only once it reports the workload's exit",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-stack-artifact-launcher-pin-",
          });
          const key = "database/postgres-launcher-pin";
          const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
          const prepared = yield* store.prepare({ ...request, key });

          const environment = yield* Environment.confine(fs, path, `${root}/home`);
          const processScope = yield* Scope.fork(yield* Scope.Scope, "sequential");
          yield* spawnNativeProcess(
            {
              executable: "/bin/sleep",
              args: ["30"],
              environment,
              artifactLockPath: prepared.lockPath,
              gracefulStopSignal: "SIGTERM",
              gracefulStopTimeout: "1 second",
            },
            defaultNativeProcessLauncher(),
          ).pipe(Scope.provide(processScope));

          yield* ageLockFile(fs, prepared.lockPath);
          yield* triggerSweep(root);
          expect(yield* fs.exists(prepared.path)).toBe(true);

          yield* Scope.close(processScope, Exit.void);
          yield* ageLockFile(fs, prepared.lockPath);
          yield* triggerSweep(root);
          expect(yield* fs.exists(prepared.path)).toBe(false);
        }),
      ),
    20_000,
  );

  it.live(
    "keeps the generation pinned until every process-group member is gone, not only the direct child",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-stack-artifact-launcher-group-",
          });
          const key = "database/postgres-launcher-group";
          const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
          const prepared = yield* store.prepare({ ...request, key });

          const environment = yield* Environment.confine(fs, path, `${root}/home`);
          const pidPath = path.join(root, "descendant.pid");
          const readyPath = path.join(root, "ready");
          const goPath = path.join(root, "go");
          const processScope = yield* Scope.fork(yield* Scope.Scope, "sequential");
          // The descendant ignores SIGTERM and records its own pid, then the leader signals
          // readiness and waits for the test's own release file before exiting: only the
          // group-wide SIGKILL in the launcher's exit handler can end the descendant.
          yield* spawnNativeProcess(
            {
              executable: "/bin/sh",
              args: [
                "-c",
                // `$!` (captured by the leader right after backgrounding) is the descendant's
                // real pid; `$$` read from inside the backgrounded subshell is unreliable here,
                // since this shell reuses the leader's own pid for it.
                '(trap "" TERM; while true; do sleep 1; done) & echo $! > "$1/descendant.pid"; ' +
                  'touch "$1/ready"; while [ ! -f "$1/go" ]; do sleep 0.05; done',
                "sh",
                root,
              ],
              environment,
              artifactLockPath: prepared.lockPath,
            },
            defaultNativeProcessLauncher(),
          ).pipe(Scope.provide(processScope));

          const pollUntil = <A, E>(
            check: Effect.Effect<A, E>,
            satisfied: (value: A) => boolean,
            guard: Duration.Input,
          ) =>
            check.pipe(
              Effect.filterOrFail(satisfied, () => "not yet" as const),
              Effect.retry({
                schedule: Schedule.spaced("20 millis").pipe(Schedule.upTo({ duration: guard })),
                while: () => true,
              }),
            );
          const isPinBusy = Effect.scoped(
            acquireLock(prepared.lockPath, "existing").pipe(
              Effect.flatMap(takeExclusiveLock),
              Effect.as(false),
              Effect.catch((error) => Effect.succeed(isBusy(error))),
            ),
          );
          const isESRCH = (cause: unknown): boolean =>
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "ESRCH";
          class ProcessProbeError extends Data.TaggedError("ProcessProbeError")<{
            readonly cause: unknown;
          }> {}
          // `true` means still alive; ESRCH resolves to `false` (terminated); any other error
          // (an unexpected probe failure) propagates instead of being read either way.
          const probeAlive = (pid: number) =>
            Effect.try({
              try: (): boolean => {
                process.kill(pid, 0);
                return true;
              },
              catch: (cause) => new ProcessProbeError({ cause }),
            }).pipe(
              Effect.catch((error) =>
                isESRCH(error.cause) ? Effect.succeed(false) : Effect.fail(error),
              ),
            );
          /**
           * Totalizes two separately-timed probes against the race where `kill(pid, 0)` finds the
           * descendant alive but it vanishes before `ps` runs moments later: `ps` finding nothing
           * (or failing outright) re-checks with `kill` rather than reading empty output as "still
           * running". An unexpected (non-ESRCH) error from either probe fails the check.
           */
          const isDescendantTerminated = (pid: number) =>
            Effect.gen(function* () {
              if (!(yield* probeAlive(pid))) return true;
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const { output, exitCode } = yield* Effect.scoped(
                Effect.gen(function* () {
                  const inspection = yield* ChildProcess.make(
                    "ps",
                    ["-o", "stat=", "-p", String(pid)],
                    {
                      stdin: "ignore",
                      stdout: "pipe",
                      stderr: "ignore",
                    },
                  );
                  const [stdout, exitCode] = yield* Effect.all(
                    [
                      inspection.stdout.pipe(Stream.decodeText, Stream.mkString),
                      inspection.exitCode,
                    ],
                    { concurrency: 2 },
                  );
                  return { output: stdout.trim(), exitCode: Number(exitCode) };
                }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
              );
              if (exitCode === 0 && output.length > 0) return output.startsWith("Z");
              return !(yield* probeAlive(pid));
            });

          // Readiness (the descendant's pid recorded, the leader waiting on `go`) is an
          // observable file, not a fixed delay: polls its existence, bounded by a guard timeout.
          yield* pollUntil(fs.exists(readyPath), (ready) => ready, "5 seconds");
          const descendantPid = Number((yield* fs.readFileString(pidPath)).trim());

          expect(yield* isPinBusy).toBe(true);

          yield* fs.writeFileString(goPath, "");

          // Polls the lock's own availability, not a fixed delay, bounded by a guard timeout.
          yield* pollUntil(isPinBusy, (busy) => !busy, "10 seconds");

          // Correlates the lock's release with the descendant's own termination: a launcher that
          // released the pin before actually killing the group would still show it running.
          expect(yield* isDescendantTerminated(descendantPid)).toBe(true);

          yield* Scope.close(processScope, Exit.void);
        }),
      ),
    20_000,
  );
});

describe("retirement across release keys", () => {
  it.live(
    "retires an older release key's stale, unlocked generation when a newer release key is prepared",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-stack-artifact-cross-key-",
          });
          // Keys embed a release version (`Artifacts.ts`'s `artifactKey`), so a CLI upgrade
          // resolves a different key entirely rather than a new digest under the same one.
          const olderKey = "database/postgres/17.0.0-r0/darwin-arm64";
          const newerKey = "database/postgres/17.0.1-r0/darwin-arm64";
          const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
          const older = yield* store.prepare({ ...request, key: olderKey });
          expect(older.outcome).toBe("downloaded");
          yield* ageLockFile(fs, older.lockPath);

          yield* store.prepare({ ...request, key: newerKey });

          expect(yield* fs.exists(older.path)).toBe(false);
          expect(yield* fs.exists(older.lockPath)).toBe(true);
        }),
      ),
  );
});
