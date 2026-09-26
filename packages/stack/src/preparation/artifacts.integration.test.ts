import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PlatformError,
} from "effect";
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

const sourceWriting = (bytes: Uint8Array = archive): ArtifactSource => ({
  checksum: () => Effect.succeed(archiveSha256),
  materialize: (_request, destination, expectedSha256) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
      yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
      yield* fs.writeFileString(`${destination}/bin/postgres`, "native postgres");
      yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config");
      const crypto = yield* Crypto.Crypto;
      yield* verifySha256(bytes, expectedSha256).pipe(Effect.provideService(Crypto.Crypto, crypto));
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof ArtifactIntegrityError
          ? cause
          : new PreparationError({
              message: `materialization failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
      ),
    ),
});

const replacesMalformedMetadata = (label: string, metadata: string | undefined) =>
  withPlatform(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: `supabase-stack-artifact-${label}-metadata-`,
      });
      const target = `${root}/${request.key}`;
      yield* fs.makeDirectory(`${target}/bin`, { recursive: true });
      yield* fs.writeFileString(`${target}/bin/postgres`, "unverified postgres");
      if (metadata !== undefined) yield* fs.writeFileString(`${target}/.artifact.json`, metadata);

      const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
      const prepared = yield* store.prepare(request);

      expect(prepared.outcome).toBe("downloaded");
      expect(yield* fs.readFileString(`${target}/bin/postgres`)).toBe("native postgres");
      expect(yield* fs.exists(`${target}/.artifact.json`)).toBe(true);
    }),
  );

describe("verified native artifact preparation", () => {
  it.live("downloads and atomically publishes an executable artifact tree", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-artifact-" });
        const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
        const prepared = yield* store.prepare(request);
        expect(prepared.outcome).toBe("downloaded");
        expect(yield* fs.exists(`${prepared.path}/bin/postgres`)).toBe(true);
        expect((yield* fs.stat(`${prepared.path}/bin/postgres`)).mode & 0o111).not.toBe(0);
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
        expect(checksumCalls).toBe(1);
        expect(materializeCalls).toBe(1);
      }),
    ),
  );

  it.live("re-downloads when required runtime paths expand on the same key", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-paths-expand-",
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
        const narrow: ArtifactRequest = { ...request, requiredRuntimePaths: ["bin/postgres"] };
        const first = yield* store.prepare(narrow);
        const second = yield* store.prepare(request);
        expect(first.outcome).toBe("downloaded");
        expect(second.outcome).toBe("downloaded");
        expect(second.requiredRuntimePaths).toEqual([...request.requiredRuntimePaths]);
        expect(checksumCalls).toBe(2);
        expect(materializeCalls).toBe(2);
      }),
    ),
  );

  it.live("replaces a cached tree with unknown artifact metadata", () =>
    replacesMalformedMetadata("unknown", '{"format":"supabase-stack-artifact-v0"}'),
  );

  it.live("replaces a cached tree with missing artifact metadata", () =>
    replacesMalformedMetadata("missing", undefined),
  );

  it.live("reuses a cache hit after required file contents are modified", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-tampered-runtime-",
        });
        const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
        const published = yield* store.prepare(request);
        yield* fs.writeFileString(`${published.path}/bin/postgres`, "tampered executable");
        const cached = yield* store.prepare(request);
        expect(cached.outcome).toBe("cached");
      }),
    ),
  );

  it.live("reuses cached directories without hashing their contents", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-directory-runtime-",
        });
        const directoryRequest: ArtifactRequest = {
          ...request,
          key: "database/postgres-directory-runtime",
          requiredRuntimePaths: ["bin/postgres", "share/runtime"],
        };
        const source: ArtifactSource = {
          checksum: () => Effect.succeed(archiveSha256),
          materialize: (_entry, destination) =>
            Effect.gen(function* () {
              yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/share/runtime`, { recursive: true });
              yield* fs.writeFileString(`${destination}/bin/postgres`, "native postgres");
              yield* fs.writeFileString(`${destination}/share/runtime/config`, "config");
              yield* fs.symlink("config", `${destination}/share/runtime/config-link`);
              return;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new PreparationError({
                    message: `materialization failed: ${cause.message}`,
                    cause,
                  }),
              ),
            ),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const prepared = yield* store.prepare(directoryRequest);
        expect((yield* store.prepare(directoryRequest)).outcome).toBe("cached");

        yield* fs.writeFileString(`${prepared.path}/share/runtime/config`, "tampered config");
        expect((yield* store.prepare(directoryRequest)).outcome).toBe("cached");
      }),
    ),
  );

  it.live("rejects a non-EINVAL readLink failure on a cache hit", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-cache-readlink-error-",
        });
        const publisher = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
        yield* publisher.prepare(request);
        const failingFs: FileSystem.FileSystem = {
          ...fs,
          readLink: (candidate) =>
            candidate.endsWith("/bin/postgres")
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "readLink",
                    pathOrDescriptor: candidate,
                    cause: { code: "EACCES" },
                  }),
                )
              : fs.readLink(candidate),
        };
        const checker = yield* makeArtifactStore({
          cacheRoot: root,
          source: sourceWriting(),
        }).pipe(Effect.provideService(FileSystem.FileSystem, failingFs));

        const exit = yield* checker.prepare(request).pipe(Effect.exit);
        const error = errorOf(exit);

        expect(error).toBeInstanceOf(ArtifactIntegrityError);
        expect(error?.message).toContain("Unable to inspect required runtime path");
      }),
    ),
  );

  it.live("does not recursively enumerate required directories on a cache hit", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-cache-no-recursion-",
        });
        const directoryRequest: ArtifactRequest = {
          ...request,
          key: "database/postgres-cache-no-recursion",
          requiredRuntimePaths: ["bin/postgres", "share/runtime"],
        };
        const source: ArtifactSource = {
          checksum: () => Effect.succeed(archiveSha256),
          materialize: (_entry, destination) =>
            Effect.gen(function* () {
              yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/share/runtime`, { recursive: true });
              yield* fs.writeFileString(`${destination}/bin/postgres`, "native postgres");
              yield* fs.writeFileString(`${destination}/share/runtime/config`, "config");
              return;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new PreparationError({
                    message: `materialization failed: ${cause.message}`,
                    cause,
                  }),
              ),
            ),
        };
        const publisher = yield* makeArtifactStore({ cacheRoot: root, source });
        yield* publisher.prepare(directoryRequest);
        const guardedFs: FileSystem.FileSystem = {
          ...fs,
          readDirectory: (candidate, options) =>
            candidate.endsWith("/share/runtime")
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "Busy",
                    module: "FileSystem",
                    method: "readDirectory",
                    pathOrDescriptor: candidate,
                    cause: { code: "EBUSY" },
                  }),
                )
              : fs.readDirectory(candidate, options),
        };
        const checker = yield* makeArtifactStore({
          cacheRoot: root,
          source,
        }).pipe(Effect.provideService(FileSystem.FileSystem, guardedFs));

        const cached = yield* checker.prepare(directoryRequest);

        expect(cached.outcome).toBe("cached");
      }),
    ),
  );

  it.live("rejects a missing required path on a cache hit", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-cache-missing-",
        });
        const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
        const published = yield* store.prepare(request);
        yield* fs.remove(`${published.path}/etc/postgres.conf`);

        const exit = yield* store.prepare(request).pipe(Effect.exit);

        expect(errorOf(exit)).toBeInstanceOf(ArtifactIntegrityError);
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
        const symlinkRequest: ArtifactRequest = {
          ...request,
          key: "database/postgres-cache-link",
        };
        const source: ArtifactSource = {
          checksum: () => Effect.succeed(archiveSha256),
          materialize: (_entry, destination) =>
            Effect.gen(function* () {
              yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
              yield* fs.writeFileString(`${destination}/bin/postgres.real`, "native postgres");
              yield* fs.symlink("postgres.real", `${destination}/bin/postgres`);
              yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config");
              return;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new PreparationError({
                    message: `materialization failed: ${cause.message}`,
                    cause,
                  }),
              ),
            ),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const published = yield* store.prepare(symlinkRequest);
        yield* fs.remove(`${published.path}/bin/postgres`);
        yield* fs.symlink(outsideExecutable, `${published.path}/bin/postgres`);

        const exit = yield* store.prepare(symlinkRequest).pipe(Effect.exit);

        expect(errorOf(exit)).toBeInstanceOf(ArtifactIntegrityError);
      }),
    ),
  );

  it.live("rejects a checksum mismatch and removes only its temporary tree", () =>
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
        const entries = yield* fs.readDirectory(root, { recursive: true });
        expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
        expect(yield* fs.exists(`${root}/database/postgres`)).toBe(false);
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
              yield* fs.makeDirectory(`${destination}/bin/postgres`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
              yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config");
              return;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new PreparationError({
                    message: `materialization failed: ${cause.message}`,
                    cause,
                  }),
              ),
            ),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const exit = yield* store.prepare(request).pipe(Effect.exit);

        expect(errorOf(exit)).toBeInstanceOf(ArtifactIntegrityError);
        const entries = yield* fs.readDirectory(root, { recursive: true });
        expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
        expect(yield* fs.exists(`${root}/database/postgres`)).toBe(false);
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
              yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
              yield* fs.writeFileString(`${destination}/bin/postgres.real`, "native postgres");
              yield* fs.symlink("postgres.real", `${destination}/bin/postgres`);
              yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config");
              return;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new PreparationError({
                    message: `materialization failed: ${cause.message}`,
                    cause,
                  }),
              ),
            ),
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
              yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
              yield* fs.symlink(outsideExecutable, `${destination}/bin/postgres`);
              yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config");
              return;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new PreparationError({
                    message: `materialization failed: ${cause.message}`,
                    cause,
                  }),
              ),
            ),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const exit = yield* store.prepare(request).pipe(Effect.exit);

        expect(errorOf(exit)).toBeInstanceOf(ArtifactIntegrityError);
        expect(yield* fs.exists(outsideExecutable)).toBe(true);
        expect(yield* fs.exists(`${root}/database/postgres`)).toBe(false);
      }),
    ),
  );

  it.live("rejects an escaping symlink nested in a fresh required directory", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-nested-link-escape-",
        });
        const outside = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-nested-link-outside-",
        });
        const outsideConfig = `${outside}/config`;
        yield* fs.writeFileString(outsideConfig, "outside");
        const directoryRequest: ArtifactRequest = {
          ...request,
          key: "database/postgres-nested-link",
          requiredRuntimePaths: ["bin/postgres", "share/runtime"],
        };
        const source: ArtifactSource = {
          checksum: () => Effect.succeed(archiveSha256),
          materialize: (_entry, destination) =>
            Effect.gen(function* () {
              yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/share/runtime`, { recursive: true });
              yield* fs.writeFileString(`${destination}/bin/postgres`, "native postgres");
              yield* fs.symlink(outsideConfig, `${destination}/share/runtime/config`);
              return;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new PreparationError({
                    message: `materialization failed: ${cause.message}`,
                    cause,
                  }),
              ),
            ),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const exit = yield* store.prepare(directoryRequest).pipe(Effect.exit);

        expect(errorOf(exit)).toBeInstanceOf(ArtifactIntegrityError);
        expect(yield* fs.exists(`${root}/database/postgres-nested-link`)).toBe(false);
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
              yield* fs.writeFileString(`${destination}/partial`, "partial");
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new PreparationError({
                    message: `materialization failed: ${cause.message}`,
                    cause,
                  }),
              ),
            ),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const preparation = yield* Effect.forkChild(store.prepare(request));
        yield* Deferred.await(started);
        yield* Fiber.interrupt(preparation);
        const entries = yield* fs.readDirectory(root, { recursive: true });
        expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
        expect(yield* fs.exists(`${root}/database/postgres`)).toBe(false);
      }),
    ),
  );

  it.live("allows separate stores to duplicate work and converge safely", () =>
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
          materialize: (entry, destination) =>
            Effect.gen(function* () {
              calls += 1;
              yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
              yield* fs.writeFileString(`${destination}/bin/postgres`, "native postgres");
              yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config");
              yield* calls === 1
                ? Deferred.succeed(firstStarted, undefined)
                : Deferred.succeed(secondStarted, undefined);
              yield* Deferred.await(release);
              return;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new PreparationError({
                    message: `materialization failed: ${cause.message}`,
                    cause,
                  }),
              ),
            ),
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
      }),
    ),
  );

  it.live("rejects traversal in keys and required runtime paths before touching the source", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-artifact-path-" });
        let called = false;
        const source: ArtifactSource = {
          checksum: () => Effect.succeed(archiveSha256),
          materialize: () =>
            Effect.sync(() => {
              called = true;
              return;
            }),
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
          materialize: () =>
            Effect.sync(() => {
              called = true;
              return;
            }),
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

describe("orphaned temp/quarantine sweep", () => {
  it.live("removes a prepared key's old leftovers and keeps fresh and unrelated ones", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-sweep-",
        });
        const now = yield* DateTime.now;
        const old = DateTime.toDate(DateTime.subtract(now, { hours: 25 }));
        const recent = DateTime.toDate(DateTime.subtract(now, { hours: 1 }));
        const parent = `${root}/database`;
        const oldTemp = `${parent}/.postgres.00000000-0000-4000-8000-000000000001.tmp`;
        const oldQuarantine = `${parent}/.postgres.00000000-0000-4000-8000-000000000002.invalid`;
        const freshTemp = `${parent}/.postgres.00000000-0000-4000-8000-000000000003.tmp`;
        const freshQuarantine = `${parent}/.postgres.00000000-0000-4000-8000-000000000004.invalid`;
        const unrelated = `${parent}/nested/.x.tmp`;
        const leftovers = [oldTemp, oldQuarantine, freshTemp, freshQuarantine, unrelated];
        for (const leftover of leftovers) {
          yield* fs.makeDirectory(leftover, { recursive: true });
          yield* fs.writeFileString(`${leftover}/marker`, "leftover");
        }
        for (const leftover of [oldTemp, oldQuarantine, unrelated])
          yield* fs.utimes(leftover, old, old);
        for (const leftover of [freshTemp, freshQuarantine])
          yield* fs.utimes(leftover, recent, recent);

        const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
        expect(yield* fs.exists(oldTemp), "construction leaves the cache alone").toBe(true);
        expect((yield* store.prepare(request)).outcome).toBe("downloaded");

        expect(yield* fs.exists(oldTemp)).toBe(false);
        expect(yield* fs.exists(oldQuarantine)).toBe(false);
        expect(yield* fs.exists(freshTemp)).toBe(true);
        expect(yield* fs.exists(freshQuarantine)).toBe(true);
        expect(yield* fs.exists(unrelated)).toBe(true);
      }),
    ),
  );
});
