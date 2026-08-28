import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Option } from "effect";
import { ArtifactIntegrityError, StackPreparationError } from "../public/Errors.ts";
import { makeArtifactStore, type ArtifactRequest, type ArtifactSource } from "./ArtifactStore.ts";

const layer = NodeServices.layer;
const archive = new TextEncoder().encode("archive");
const archiveSha256 = "0eb3e36bfb24dcd9bb1d1bece1531216b59539a8fde17ee80224af0653c92aa3";
const request: ArtifactRequest = {
  key: "database/postgres",
  sha256: archiveSha256,
  requiredRuntimePaths: ["bin/postgres", "etc/postgres.conf"],
  executablePath: "bin/postgres",
};

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(layer));

const sourceWriting = (bytes: Uint8Array = archive): ArtifactSource => ({
  materialize: (_request, destination) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
      yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
      yield* fs.writeFileString(`${destination}/bin/postgres`, "native postgres");
      yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config");
      return bytes;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new StackPreparationError({ message: `materialization failed: ${cause.message}`, cause }),
      ),
    ),
});

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
        expect(yield* fs.exists(`${root}/database/postgres/.artifact-source`)).toBe(true);
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
        let calls = 0;
        const source: ArtifactSource = {
          materialize: (entry, destination) =>
            Effect.sync(() => {
              calls += 1;
              return entry;
            }).pipe(Effect.andThen(sourceWriting().materialize(entry, destination))),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const first = yield* store.prepare(request);
        const second = yield* store.prepare(request);
        expect(first.outcome).toBe("downloaded");
        expect(second.outcome).toBe("cached");
        expect(calls).toBe(1);
      }),
    ),
  );

  it.live("rejects a corrupted cached archive without replacing the published tree", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-corrupt-cache-",
        });
        const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
        const published = yield* store.prepare(request);
        yield* fs.writeFileString(`${published.path}/.artifact-source`, "corrupt");

        const exit = yield* store.prepare(request).pipe(Effect.exit);
        expect(errorOf(exit)).toBeInstanceOf(ArtifactIntegrityError);
        expect(yield* fs.exists(`${published.path}/bin/postgres`)).toBe(true);
        expect(yield* fs.exists(`${published.path}/.artifact-source`)).toBe(true);
      }),
    ),
  );

  it.live("fails closed for a conflicting request without replacing the published tree", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-conflict-",
        });
        const store = yield* makeArtifactStore({ cacheRoot: root, source: sourceWriting() });
        const published = yield* store.prepare(request);
        const conflict = yield* store
          .prepare({ ...request, sha256: "1".repeat(64) })
          .pipe(Effect.exit);
        expect(errorOf(conflict)).toBeInstanceOf(ArtifactIntegrityError);
        expect(yield* fs.exists(`${published.path}/bin/postgres`)).toBe(true);
        expect(yield* fs.exists(`${published.path}/.artifact-source`)).toBe(true);
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
          materialize: (_entry, destination) =>
            Effect.gen(function* () {
              yield* fs.makeDirectory(`${destination}/bin/postgres`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
              yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config");
              return archive;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new StackPreparationError({
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
          materialize: (_entry, destination) =>
            Effect.gen(function* () {
              yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
              yield* fs.writeFileString(`${destination}/bin/postgres.real`, "native postgres");
              yield* fs.symlink("postgres.real", `${destination}/bin/postgres`);
              yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config");
              return archive;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new StackPreparationError({
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
          materialize: (_entry, destination) =>
            Effect.gen(function* () {
              yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
              yield* fs.symlink(outsideExecutable, `${destination}/bin/postgres`);
              yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config");
              return archive;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new StackPreparationError({
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

  it.live("cancels the owner when the store scope closes", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-cancel-",
        });
        const started = yield* Deferred.make<void>();
        const source: ArtifactSource = {
          materialize: (_entry, destination) =>
            Effect.gen(function* () {
              yield* fs.writeFileString(`${destination}/partial`, "partial");
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new StackPreparationError({
                    message: `materialization failed: ${cause.message}`,
                    cause,
                  }),
              ),
            ),
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* makeArtifactStore({ cacheRoot: root, source });
            yield* Effect.forkChild(store.prepare(request));
            yield* Deferred.await(started);
          }),
        );
        const entries = yield* fs.readDirectory(root, { recursive: true });
        expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
        expect(yield* fs.exists(`${root}/database/postgres`)).toBe(false);
      }),
    ),
  );

  it.live("continues a sole preparation after its waiter is interrupted", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-waiters-",
        });
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        const source: ArtifactSource = {
          materialize: (entry, destination) =>
            Effect.gen(function* () {
              calls += 1;
              yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
              yield* fs.writeFileString(`${destination}/bin/postgres`, "native postgres");
              yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config");
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return archive;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new StackPreparationError({
                    message: `materialization failed: ${cause.message}`,
                    cause,
                  }),
              ),
            ),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const first = yield* Effect.forkChild(store.prepare(request));
        yield* Deferred.await(started);
        yield* Fiber.interrupt(first);
        const second = yield* Effect.forkChild(store.prepare(request));
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(second);
        expect(result.outcome).toBe("downloaded");
        expect(calls).toBe(1);
        const cached = yield* store.prepare(request);
        expect(cached.outcome).toBe("cached");
      }),
    ),
  );

  it.live("shares one in-flight preparation within a store instance", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-stack-artifact-flight-",
        });
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        const source: ArtifactSource = {
          materialize: (entry, destination) =>
            Effect.gen(function* () {
              calls += 1;
              yield* fs.makeDirectory(`${destination}/bin`, { recursive: true });
              yield* fs.makeDirectory(`${destination}/etc`, { recursive: true });
              yield* fs.writeFileString(`${destination}/bin/postgres`, "native postgres");
              yield* fs.writeFileString(`${destination}/etc/postgres.conf`, "config");
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return archive;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new StackPreparationError({
                    message: `materialization failed: ${cause.message}`,
                    cause,
                  }),
              ),
            ),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const first = yield* Effect.forkChild(store.prepare(request));
        const second = yield* Effect.forkChild(store.prepare(request));
        yield* Deferred.await(started);
        yield* Deferred.succeed(release, undefined);
        const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
        expect(calls).toBe(1);
        expect(results[0].path).toBe(results[1].path);
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
              return archive;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new StackPreparationError({
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
          materialize: () =>
            Effect.sync(() => {
              called = true;
              return archive;
            }),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const keyExit = yield* store.prepare({ ...request, key: "../escape" }).pipe(Effect.exit);
        const pathExit = yield* store
          .prepare({ ...request, requiredRuntimePaths: ["bin/../escape"] })
          .pipe(Effect.exit);
        expect(errorOf(keyExit)).toBeInstanceOf(StackPreparationError);
        expect(errorOf(pathExit)).toBeInstanceOf(StackPreparationError);
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
          materialize: () =>
            Effect.sync(() => {
              called = true;
              return archive;
            }),
        };
        const store = yield* makeArtifactStore({ cacheRoot: root, source });
        const exit = yield* store.prepare({ ...request, key: "nested/postgres" }).pipe(Effect.exit);

        expect(errorOf(exit)).toBeInstanceOf(StackPreparationError);
        expect(called).toBe(false);
        expect(yield* fs.exists(`${outside}/postgres`)).toBe(false);
      }),
    ),
  );
});
