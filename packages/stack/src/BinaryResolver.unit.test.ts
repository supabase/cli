import { describe, expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Sink,
  Stream,
} from "effect";
import { HttpClient } from "effect/unstable/http";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ChildProcessSpawner } from "effect/unstable/process";
import { BinaryResolver, type BinarySpec } from "./BinaryResolver.ts";
import { DownloadError } from "./errors.ts";
import { detectPlatform, postgresAssetName, postgrestAssetName } from "./Platform.ts";
import { DEFAULT_VERSIONS } from "./versions.ts";

const postgresVersion = DEFAULT_VERSIONS.postgres;
const postgrestVersion = DEFAULT_VERSIONS.postgrest;
const authVersion = DEFAULT_VERSIONS.auth;
const authRcVersion = "2.188.0-rc.15";
const edgeRuntimeVersion = DEFAULT_VERSIONS["edge-runtime"];

describe("BinaryResolver.downloadUrl", () => {
  it("constructs postgres URL (appends -cli suffix for native binaries)", () => {
    const url = BinaryResolver.downloadUrl({
      service: "postgres",
      version: postgresVersion,
      assetName: "darwin-arm64",
    });
    expect(url).toBe(
      `https://github.com/supabase/postgres/releases/download/v${postgresVersion}-cli/supabase-postgres-v${postgresVersion}-cli-darwin-arm64.tar.gz`,
    );
  });

  it("constructs postgrest URL", () => {
    const url = BinaryResolver.downloadUrl({
      service: "postgrest",
      version: postgrestVersion,
      assetName: "macos-aarch64",
    });
    expect(url).toBe(
      `https://github.com/PostgREST/postgrest/releases/download/v${postgrestVersion}/postgrest-v${postgrestVersion}-macos-aarch64.tar.xz`,
    );
  });

  it("constructs postgrest Windows URL with .zip extension", () => {
    const url = BinaryResolver.downloadUrl({
      service: "postgrest",
      version: postgrestVersion,
      assetName: "windows-x86-64",
    });
    expect(url).toBe(
      `https://github.com/PostgREST/postgrest/releases/download/v${postgrestVersion}/postgrest-v${postgrestVersion}-windows-x86-64.zip`,
    );
  });

  it("constructs auth URL for rc releases", () => {
    const url = BinaryResolver.downloadUrl({
      service: "auth",
      version: authRcVersion,
      assetName: "arm64",
    });
    expect(url).toBe(
      `https://github.com/supabase/auth/releases/download/rc${authRcVersion}/auth-v${authRcVersion}-arm64.tar.gz`,
    );
  });

  it("constructs edge-runtime URL", () => {
    const url = BinaryResolver.downloadUrl({
      service: "edge-runtime",
      version: edgeRuntimeVersion,
      assetName: "aarch64-darwin",
    });
    expect(url).toBe(
      `https://github.com/supabase/edge-runtime/releases/download/v${edgeRuntimeVersion}/edge-runtime-v${edgeRuntimeVersion}-aarch64-darwin.tar.gz`,
    );
  });
});

describe("BinaryResolver.checksumUrl", () => {
  it("appends .sha256 for postgres", () => {
    const url = BinaryResolver.checksumUrl({
      service: "postgres",
      version: postgresVersion,
      assetName: "darwin-arm64",
    });
    expect(url).toBe(
      `https://github.com/supabase/postgres/releases/download/v${postgresVersion}-cli/supabase-postgres-v${postgresVersion}-cli-darwin-arm64.tar.gz.sha256`,
    );
  });

  it("returns null for postgrest (no checksum published)", () => {
    expect(
      BinaryResolver.checksumUrl({
        service: "postgrest",
        version: postgrestVersion,
        assetName: "macos-aarch64",
      }),
    ).toBeNull();
  });

  it("returns null for auth (no checksum published)", () => {
    expect(
      BinaryResolver.checksumUrl({
        service: "auth",
        version: authVersion,
        assetName: "arm64",
      }),
    ).toBeNull();
  });

  it("returns null for edge-runtime (no checksum published)", () => {
    expect(
      BinaryResolver.checksumUrl({
        service: "edge-runtime",
        version: edgeRuntimeVersion,
        assetName: "aarch64-darwin",
      }),
    ).toBeNull();
  });
});

describe("BinaryResolver.cachePath", () => {
  it("constructs cache path", () => {
    const path = BinaryResolver.cachePath("/home/user/.supabase/bin", {
      service: "postgres",
      version: postgresVersion,
      assetName: "darwin-arm64",
    });
    expect(path).toBe(`/home/user/.supabase/bin/postgres/${postgresVersion}/darwin-arm64`);
  });
});

/**
 * A tiny in-memory hierarchical filesystem used to exercise BinaryResolver's
 * real staging/rename logic (not just its pure helpers). Tracks directories
 * and files by absolute path so `rename` can faithfully reject a move onto a
 * non-empty destination the way POSIX `rename(2)` does — the exact signal the
 * resolver relies on to detect that a concurrent resolve already won.
 */
function createFakeCacheFs() {
  const dirs = new Set<string>();
  const files = new Map<string, Uint8Array>();
  const mtimes = new Map<string, number>();
  const removeInterceptors = new Map<string, () => void>();
  const alwaysFailRenameTo = new Set<string>();

  const isWithin = (candidatePath: string, rootPath: string): boolean =>
    candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);

  const addAncestorDirs = (childPath: string): void => {
    const segments = childPath.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < segments.length - 1; i++) {
      current += `/${segments[i]}`;
      dirs.add(current);
      if (!mtimes.has(current)) mtimes.set(current, Date.now());
    }
  };

  const removeSubtree = (rootPath: string): void => {
    for (const key of files.keys()) if (isWithin(key, rootPath)) files.delete(key);
    for (const key of dirs) if (isWithin(key, rootPath)) dirs.delete(key);
  };

  const hasContentAt = (targetPath: string): boolean =>
    [...files.keys(), ...dirs].some((key) => key !== targetPath && isWithin(key, targetPath));

  const layer = Layer.succeed(
    FileSystem.FileSystem,
    FileSystem.makeNoop({
      exists: (targetPath) => Effect.succeed(files.has(targetPath) || dirs.has(targetPath)),
      makeDirectory: (dirPath) =>
        Effect.sync(() => {
          dirs.add(dirPath);
          mtimes.set(dirPath, Date.now());
          addAncestorDirs(dirPath);
        }),
      stat: (targetPath) =>
        Effect.sync(
          (): FileSystem.File.Info => ({
            type: dirs.has(targetPath) ? "Directory" : "File",
            mtime: Option.some(new Date(mtimes.get(targetPath) ?? Date.now())),
            atime: Option.none(),
            birthtime: Option.none(),
            dev: 0,
            ino: Option.none(),
            mode: 0,
            nlink: Option.none(),
            uid: Option.none(),
            gid: Option.none(),
            rdev: Option.none(),
            size: FileSystem.Size(0),
            blksize: Option.none(),
            blocks: Option.none(),
          }),
        ),
      readDirectory: (dirPath) =>
        Effect.sync(() => {
          const prefix = `${dirPath}/`;
          const names = new Set<string>();
          for (const key of [...files.keys(), ...dirs]) {
            if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]!);
          }
          return [...names];
        }),
      writeFile: (filePath, data) =>
        Effect.sync(() => {
          files.set(filePath, data);
          addAncestorDirs(filePath);
        }),
      remove: (targetPath, options) => {
        const targetExists = files.has(targetPath) || dirs.has(targetPath);
        if (!targetExists && !options?.force) {
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "remove",
              description: "no such file or directory",
              pathOrDescriptor: targetPath,
            }),
          );
        }
        return Effect.sync(() => {
          removeSubtree(targetPath);
          const intercept = removeInterceptors.get(targetPath);
          if (intercept) {
            removeInterceptors.delete(targetPath);
            intercept();
          }
        });
      },
      rename: (oldPath, newPath) => {
        if (alwaysFailRenameTo.has(newPath)) {
          return Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "rename",
              description: "permission denied (simulated permanent failure)",
              pathOrDescriptor: newPath,
            }),
          );
        }
        if (hasContentAt(newPath)) {
          return Effect.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: "rename",
              description: "destination directory not empty",
              pathOrDescriptor: newPath,
            }),
          );
        }
        return Effect.sync(() => {
          removeSubtree(newPath);
          for (const key of files.keys()) {
            if (isWithin(key, oldPath)) {
              const data = files.get(key)!;
              files.delete(key);
              files.set(`${newPath}${key.slice(oldPath.length)}`, data);
            }
          }
          for (const key of dirs) {
            if (isWithin(key, oldPath)) {
              dirs.delete(key);
              dirs.add(`${newPath}${key.slice(oldPath.length)}`);
            }
          }
          addAncestorDirs(newPath);
        });
      },
    }),
  );

  return {
    layer,
    dirs,
    files,
    /** Simulates `tar`/`unzip` populating a destination directory. */
    writeExtractedFile: (destDir: string): void => {
      const filePath = `${destDir}/bin/postgrest`;
      files.set(filePath, new Uint8Array([1, 2, 3]));
      addAncestorDirs(filePath);
    },
    /** Lists the immediate children of a directory, mirroring `fs.readDirectory`. */
    readEntriesOf: (dirPath: string): string[] => {
      const prefix = `${dirPath}/`;
      const names = new Set<string>();
      for (const key of [...files.keys(), ...dirs]) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
    /** Backdates (or refreshes) a path's fake mtime, for staleness tests. */
    setMtime: (targetPath: string, when: Date): void => {
      mtimes.set(targetPath, when.getTime());
    },
    /** Directly seeds a directory with content, bypassing the resolver — simulates
     * a pre-existing cacheDir left by an older, pre-atomic-rename CLI version or
     * an abandoned staging directory from a killed process. */
    seedDirWithFile: (dirPath: string, relativeFilePath: string): void => {
      dirs.add(dirPath);
      if (!mtimes.has(dirPath)) mtimes.set(dirPath, Date.now());
      const filePath = `${dirPath}/${relativeFilePath}`;
      files.set(filePath, new Uint8Array([9, 9, 9]));
      addAncestorDirs(filePath);
    },
    /** Registers a one-shot side effect to run the next time `targetPath` is
     * removed — simulates a third party (a concurrent resolver, or a legacy
     * writer) acting in the exact gap right after this process's own removal. */
    onRemove: (targetPath: string, sideEffect: () => void): void => {
      removeInterceptors.set(targetPath, sideEffect);
    },
    /** Makes every rename into `targetPath` fail permanently (regardless of
     * destination content), simulating a filesystem error unrelated to
     * destination contention — e.g. permissions, a read-only mount. */
    alwaysFailRenameTo: (targetPath: string): void => {
      alwaysFailRenameTo.add(targetPath);
    },
  };
}

/**
 * A `ChildProcessSpawner` that "extracts" by dropping a fake binary into
 * whichever directory the `tar -C`/`unzip -d` destination argument points at,
 * so the shared fake filesystem reflects a completed extraction.
 */
function mockExtractingSpawner(fakeFs: ReturnType<typeof createFakeCacheFs>) {
  const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];

  return {
    layer: Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const cmd = command._tag === "StandardCommand" ? command.command : "";
          const args = command._tag === "StandardCommand" ? command.args : [];
          spawned.push({ command: cmd, args });

          if (cmd === "tar" || cmd === "unzip") {
            const flagIndex = args.findIndex((arg) => arg === "-C" || arg === "-d");
            const destDir = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
            if (destDir) fakeFs.writeExtractedFile(destDir);
          }

          const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(0));

          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(5000 + spawned.length),
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode: Deferred.await(exitDeferred),
            isRunning: Effect.succeed(false),
            stdin: Sink.drain,
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
    get spawned() {
      return spawned;
    },
  };
}

/** An `HttpClient` that returns a fixed archive body after a short delay, so concurrent resolves overlap. */
function mockDownloadHttpClient(opts: { archiveBytes: Uint8Array; delayMs: number }) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        yield* Effect.sleep(`${opts.delayMs} millis`);
        return HttpClientResponse.fromWeb(request, new Response(opts.archiveBytes));
      }),
    ),
  );
}

/** An `HttpClient` that always fails, simulating an offline machine or a GitHub outage. */
function mockOfflineHttpClient() {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: "offline (simulated)",
          }),
        }),
      ),
    ),
  );
}

describe("BinaryResolver.resolveWithMetadata concurrency", () => {
  it.live(
    "two concurrent resolves for the same spec share one complete cache entry and leave no temp artifacts",
    () => {
      const fakeFs = createFakeCacheFs();
      const spawner = mockExtractingSpawner(fakeFs);
      const httpLayer = mockDownloadHttpClient({
        archiveBytes: new Uint8Array([1, 2, 3, 4]),
        delayMs: 20,
      });

      const layer = BinaryResolver.make("/cache-root").pipe(
        Layer.provide(fakeFs.layer),
        Layer.provide(Path.layer),
        Layer.provide(httpLayer),
        Layer.provide(spawner.layer),
      );

      return Effect.gen(function* () {
        const resolver = yield* BinaryResolver;
        const spec: BinarySpec = { service: "postgrest", version: postgrestVersion };

        const [first, second] = yield* Effect.all(
          [resolver.resolveWithMetadata(spec), resolver.resolveWithMetadata(spec)],
          { concurrency: "unbounded" },
        );

        // Both invocations resolve to the same, single cache entry.
        expect(first.path).toBe(second.path);
        // Exactly one of the two actually populated the cache; the other lost the race.
        expect([first.downloaded, second.downloaded].sort()).toEqual([false, true]);

        const entries = fakeFs.readEntriesOf(first.path);
        expect(entries.length).toBeGreaterThan(0);

        const staleTmpPaths = [...fakeFs.dirs, ...fakeFs.files.keys()].filter(
          (candidatePath) => candidatePath.includes(".tmp-") || candidatePath.includes("_download"),
        );
        expect(staleTmpPaths).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );
});

/** Resolves the real cacheDir a `postgres` spec would use on the host running the test. */
const resolvePostgresCacheDir = Effect.gen(function* () {
  const platform = yield* detectPlatform;
  const assetName = postgresAssetName(platform);
  if (assetName === null) {
    return yield* Effect.die(`unsupported test platform: ${platform.os}-${platform.arch}`);
  }
  return BinaryResolver.cachePath("/cache-root/bin", {
    service: "postgres",
    version: postgresVersion,
    assetName,
  });
});

/** Resolves the real cacheDir a `postgrest` spec would use on the host running the test. */
const resolvePostgrestCacheDir = Effect.gen(function* () {
  const platform = yield* detectPlatform;
  const assetName = postgrestAssetName(platform);
  if (assetName === null) {
    return yield* Effect.die(`unsupported test platform: ${platform.os}-${platform.arch}`);
  }
  return BinaryResolver.cachePath("/cache-root/bin", {
    service: "postgrest",
    version: postgrestVersion,
    assetName,
  });
});

describe("BinaryResolver.resolveWithMetadata stale staging cleanup", () => {
  it.live(
    "reaps an abandoned staging directory older than the age threshold on a later resolve",
    () => {
      const fakeFs = createFakeCacheFs();
      const spawner = mockExtractingSpawner(fakeFs);
      const httpLayer = mockDownloadHttpClient({
        archiveBytes: new Uint8Array([1, 2, 3]),
        delayMs: 0,
      });

      const layer = BinaryResolver.make("/cache-root").pipe(
        Layer.provide(fakeFs.layer),
        Layer.provide(Path.layer),
        Layer.provide(httpLayer),
        Layer.provide(spawner.layer),
      );

      return Effect.gen(function* () {
        const resolver = yield* BinaryResolver;
        const cacheDir = yield* resolvePostgrestCacheDir;
        const abandonedDir = `${cacheDir}.tmp-abandoned`;

        // Simulate a staging directory left behind by a process that was
        // SIGKILL'd/OOM-killed mid-download, more than the age threshold ago.
        fakeFs.seedDirWithFile(abandonedDir, "_download-abandoned.tar");
        fakeFs.setMtime(abandonedDir, new Date(Date.now() - 25 * 60 * 60 * 1000));

        yield* resolver.resolveWithMetadata({ service: "postgrest", version: postgrestVersion });

        expect(fakeFs.dirs.has(abandonedDir)).toBe(false);
        expect([...fakeFs.files.keys()].some((p) => p.startsWith(abandonedDir))).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "leaves a fresh staging directory alone (not old enough to be considered abandoned)",
    () => {
      const fakeFs = createFakeCacheFs();
      const spawner = mockExtractingSpawner(fakeFs);
      const httpLayer = mockDownloadHttpClient({
        archiveBytes: new Uint8Array([1, 2, 3]),
        delayMs: 0,
      });

      const layer = BinaryResolver.make("/cache-root").pipe(
        Layer.provide(fakeFs.layer),
        Layer.provide(Path.layer),
        Layer.provide(httpLayer),
        Layer.provide(spawner.layer),
      );

      return Effect.gen(function* () {
        const resolver = yield* BinaryResolver;
        const cacheDir = yield* resolvePostgrestCacheDir;
        const freshDir = `${cacheDir}.tmp-fresh`;

        // A staging directory from a genuinely live concurrent download —
        // recent mtime, must survive the sweep.
        fakeFs.seedDirWithFile(freshDir, "_download-fresh.tar");
        fakeFs.setMtime(freshDir, new Date());

        yield* resolver.resolveWithMetadata({ service: "postgrest", version: postgrestVersion });

        expect(fakeFs.dirs.has(freshDir)).toBe(true);
        expect(fakeFs.files.has(`${freshDir}/_download-fresh.tar`)).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "still reaps a stale staging sibling even when this resolve is itself a cache hit",
    () => {
      const fakeFs = createFakeCacheFs();
      const spawner = mockExtractingSpawner(fakeFs);
      const httpLayer = mockDownloadHttpClient({
        archiveBytes: new Uint8Array([1, 2, 3]),
        delayMs: 0,
      });

      const layer = BinaryResolver.make("/cache-root").pipe(
        Layer.provide(fakeFs.layer),
        Layer.provide(Path.layer),
        Layer.provide(httpLayer),
        Layer.provide(spawner.layer),
      );

      return Effect.gen(function* () {
        const resolver = yield* BinaryResolver;
        const spec: BinarySpec = { service: "postgrest", version: postgrestVersion };
        const cacheDir = yield* resolvePostgrestCacheDir;

        // Populate a genuine, complete cache entry first.
        const first = yield* resolver.resolveWithMetadata(spec);
        expect(first.downloaded).toBe(true);

        // Now a *different* invocation gets killed mid-download, abandoning
        // a stale staging sibling next to the now-complete cacheDir.
        const abandonedDir = `${cacheDir}.tmp-abandoned`;
        fakeFs.seedDirWithFile(abandonedDir, "_download-abandoned.tar");
        fakeFs.setMtime(abandonedDir, new Date(Date.now() - 25 * 60 * 60 * 1000));

        // This resolve is a plain cache hit (marker already present) — the
        // sweep must still run and reap the abandoned sibling, since once
        // cacheDir is complete this spec will only ever take the hit path.
        const second = yield* resolver.resolveWithMetadata(spec);
        expect(second.downloaded).toBe(false);

        expect(fakeFs.dirs.has(abandonedDir)).toBe(false);
        expect([...fakeFs.files.keys()].some((p) => p.startsWith(abandonedDir))).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("BinaryResolver.resolveWithMetadata cache completeness", () => {
  it.live("reclaims a broken cacheDir left by an older, pre-atomic-rename CLI version", () => {
    const fakeFs = createFakeCacheFs();
    const spawner = mockExtractingSpawner(fakeFs);
    const httpLayer = mockDownloadHttpClient({
      archiveBytes: new Uint8Array([1, 2, 3]),
      delayMs: 0,
    });

    const layer = BinaryResolver.make("/cache-root").pipe(
      Layer.provide(fakeFs.layer),
      Layer.provide(Path.layer),
      Layer.provide(httpLayer),
      Layer.provide(spawner.layer),
    );

    return Effect.gen(function* () {
      const resolver = yield* BinaryResolver;
      const spec: BinarySpec = { service: "postgrest", version: postgrestVersion };
      const cacheDir = yield* resolvePostgrestCacheDir;

      // A non-empty cacheDir with no completion marker — exactly what an
      // older, pre-atomic-rename CLI version would leave behind if it was
      // killed mid-extraction (it wrote directly into cacheDir, no staging).
      fakeFs.seedDirWithFile(cacheDir, "stray-legacy-file.txt");

      const result = yield* resolver.resolveWithMetadata(spec);

      // The broken leftover was reclaimed, not trusted or left in place.
      expect(result.path).toBe(cacheDir);
      expect(result.downloaded).toBe(true);
      expect(fakeFs.files.has(`${cacheDir}/stray-legacy-file.txt`)).toBe(false);

      // A subsequent resolve is now a clean cache hit — proving the
      // reclaimed entry is genuinely complete (carries the marker), not
      // just superficially non-empty again.
      const second = yield* resolver.resolveWithMetadata(spec);
      expect(second.downloaded).toBe(false);
      expect(second.path).toBe(cacheDir);
    }).pipe(Effect.provide(layer));
  });

  it.live("adopts a legitimate winner that lands mid-reclaim instead of retrying blindly", () => {
    const fakeFs = createFakeCacheFs();
    const spawner = mockExtractingSpawner(fakeFs);
    const httpLayer = mockDownloadHttpClient({
      archiveBytes: new Uint8Array([1, 2, 3]),
      delayMs: 0,
    });

    const layer = BinaryResolver.make("/cache-root").pipe(
      Layer.provide(fakeFs.layer),
      Layer.provide(Path.layer),
      Layer.provide(httpLayer),
      Layer.provide(spawner.layer),
    );

    return Effect.gen(function* () {
      const resolver = yield* BinaryResolver;
      const spec: BinarySpec = { service: "postgrest", version: postgrestVersion };
      const cacheDir = yield* resolvePostgrestCacheDir;

      // A markerless, broken cacheDir — our first renameOnce() attempt
      // fails against this, entering the reclaim branch.
      fakeFs.seedDirWithFile(cacheDir, "stray-legacy-file.txt");

      // Simulate a legitimate winner (a third concurrent resolver, or a
      // pre-atomic-rename legacy writer) publishing a complete,
      // marker-carrying cacheDir in the exact gap between our reclaim's
      // `fs.remove` and our retry rename.
      fakeFs.onRemove(cacheDir, () => {
        fakeFs.seedDirWithFile(cacheDir, "bin/postgrest");
        fakeFs.seedDirWithFile(cacheDir, BinaryResolver.CACHE_COMPLETE_MARKER);
      });

      const result = yield* resolver.resolveWithMetadata(spec);

      // Adopted the winner instead of throwing a spurious DownloadError
      // from the retry's second rename failure.
      expect(result.path).toBe(cacheDir);
      expect(result.downloaded).toBe(false);
      expect(fakeFs.files.has(`${cacheDir}/${BinaryResolver.CACHE_COMPLETE_MARKER}`)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "surfaces a DownloadError instead of retrying forever when rename fails for a reason unrelated to destination contention",
    () => {
      const fakeFs = createFakeCacheFs();
      const spawner = mockExtractingSpawner(fakeFs);
      const httpLayer = mockDownloadHttpClient({
        archiveBytes: new Uint8Array([1, 2, 3]),
        delayMs: 0,
      });

      const layer = BinaryResolver.make("/cache-root").pipe(
        Layer.provide(fakeFs.layer),
        Layer.provide(Path.layer),
        Layer.provide(httpLayer),
        Layer.provide(spawner.layer),
      );

      return Effect.gen(function* () {
        const resolver = yield* BinaryResolver;
        const spec: BinarySpec = { service: "postgrest", version: postgrestVersion };
        const cacheDir = yield* resolvePostgrestCacheDir;

        // Simulate a permanent filesystem error unrelated to a competing
        // destination (e.g. permissions, a read-only mount) — every rename
        // attempt into cacheDir fails, regardless of its content, so no
        // amount of reclaim-and-retry can ever succeed.
        fakeFs.alwaysFailRenameTo(cacheDir);

        const error = yield* resolver.resolveWithMetadata(spec).pipe(Effect.flip);

        // Bounded attempts surface the real error instead of hanging.
        expect(error).toBeInstanceOf(DownloadError);

        // The `cleanupTmpDir` finalizer must still remove the staging
        // directory even though the rename it was guarding rethrew — a
        // regression here (e.g. scoping cleanup to an `onError` around
        // `stage` instead of `Effect.ensuring`) would leak the fully
        // populated `.tmp-`/`_download` tree.
        const staleTmpPaths = [...fakeFs.dirs, ...fakeFs.files.keys()].filter(
          (candidatePath) => candidatePath.includes(".tmp-") || candidatePath.includes("_download"),
        );
        expect(staleTmpPaths).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("falls back to a markerless legacy cacheDir when the replacement download fails", () => {
    const fakeFs = createFakeCacheFs();
    const spawner = mockExtractingSpawner(fakeFs);
    const httpLayer = mockOfflineHttpClient();

    const layer = BinaryResolver.make("/cache-root").pipe(
      Layer.provide(fakeFs.layer),
      Layer.provide(Path.layer),
      Layer.provide(httpLayer),
      Layer.provide(spawner.layer),
    );

    return Effect.gen(function* () {
      const resolver = yield* BinaryResolver;
      const spec: BinarySpec = { service: "postgrest", version: postgrestVersion };
      const cacheDir = yield* resolvePostgrestCacheDir;

      // A markerless legacy cacheDir from before this resolver's staging
      // model existed — a binary that served every earlier release. When
      // the replacement cannot be fetched, resolving to it beats failing.
      fakeFs.seedDirWithFile(cacheDir, "postgrest");

      const result = yield* resolver.resolveWithMetadata(spec);

      expect(result.path).toBe(cacheDir);
      expect(result.downloaded).toBe(false);
      expect(fakeFs.files.has(`${cacheDir}/postgrest`)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("accepts a Windows legacy cache whose executable carries the .exe suffix", () => {
    const fakeFs = createFakeCacheFs();
    const spawner = mockExtractingSpawner(fakeFs);
    const httpLayer = mockOfflineHttpClient();

    const layer = BinaryResolver.make("/cache-root").pipe(
      Layer.provide(fakeFs.layer),
      Layer.provide(Path.layer),
      Layer.provide(httpLayer),
      Layer.provide(spawner.layer),
    );

    return Effect.gen(function* () {
      const resolver = yield* BinaryResolver;
      const spec: BinarySpec = { service: "postgrest", version: postgrestVersion };
      const cacheDir = yield* resolvePostgrestCacheDir;

      fakeFs.seedDirWithFile(cacheDir, "postgrest.exe");

      const result = yield* resolver.resolveWithMetadata(spec);

      expect(result.path).toBe(cacheDir);
      expect(result.downloaded).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a postgres legacy cache with the init script but no bin payload", () => {
    // The init script alone cannot run postgres — the health check invokes
    // bin/pg_isready and the script needs the server binaries. A partial
    // extraction stopping after share/ must not suppress the Docker fallback.
    const fakeFs = createFakeCacheFs();
    const spawner = mockExtractingSpawner(fakeFs);
    const httpLayer = mockOfflineHttpClient();

    const layer = BinaryResolver.make("/cache-root").pipe(
      Layer.provide(fakeFs.layer),
      Layer.provide(Path.layer),
      Layer.provide(httpLayer),
      Layer.provide(spawner.layer),
    );

    return Effect.gen(function* () {
      const resolver = yield* BinaryResolver;
      const spec: BinarySpec = { service: "postgres", version: postgresVersion };
      const cacheDir = yield* resolvePostgresCacheDir;

      fakeFs.seedDirWithFile(cacheDir, "share/supabase-cli/bin/supabase-postgres-init.sh");

      const error = yield* resolver.resolveWithMetadata(spec).pipe(Effect.flip);
      expect(error).toBeInstanceOf(DownloadError);
    }).pipe(Effect.provide(layer));
  });

  it.live("accepts a postgres legacy cache carrying the full expected layout", () => {
    const fakeFs = createFakeCacheFs();
    const spawner = mockExtractingSpawner(fakeFs);
    const httpLayer = mockOfflineHttpClient();

    const layer = BinaryResolver.make("/cache-root").pipe(
      Layer.provide(fakeFs.layer),
      Layer.provide(Path.layer),
      Layer.provide(httpLayer),
      Layer.provide(spawner.layer),
    );

    return Effect.gen(function* () {
      const resolver = yield* BinaryResolver;
      const spec: BinarySpec = { service: "postgres", version: postgresVersion };
      const cacheDir = yield* resolvePostgresCacheDir;

      fakeFs.seedDirWithFile(cacheDir, "share/supabase-cli/bin/supabase-postgres-init.sh");
      fakeFs.seedDirWithFile(cacheDir, "bin/pg_isready");
      fakeFs.seedDirWithFile(cacheDir, "bin/postgres");

      const result = yield* resolver.resolveWithMetadata(spec);
      expect(result.path).toBe(cacheDir);
      expect(result.downloaded).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("rejects a partial markerless leftover that lacks the service entrypoint", () => {
    // A pre-staging writer killed mid-extraction leaves a non-empty dir with
    // no executable. Resolving it would mask the DownloadError that lets the
    // stack fall back to a Docker image — so non-emptiness is not enough.
    const fakeFs = createFakeCacheFs();
    const spawner = mockExtractingSpawner(fakeFs);
    const httpLayer = mockOfflineHttpClient();

    const layer = BinaryResolver.make("/cache-root").pipe(
      Layer.provide(fakeFs.layer),
      Layer.provide(Path.layer),
      Layer.provide(httpLayer),
      Layer.provide(spawner.layer),
    );

    return Effect.gen(function* () {
      const resolver = yield* BinaryResolver;
      const spec: BinarySpec = { service: "postgrest", version: postgrestVersion };
      const cacheDir = yield* resolvePostgrestCacheDir;

      fakeFs.seedDirWithFile(cacheDir, "_download-interrupted.tar");

      const error = yield* resolver.resolveWithMetadata(spec).pipe(Effect.flip);

      expect(error).toBeInstanceOf(DownloadError);
    }).pipe(Effect.provide(layer));
  });

  it.live("still fails offline when no legacy cache entry exists to fall back to", () => {
    const fakeFs = createFakeCacheFs();
    const spawner = mockExtractingSpawner(fakeFs);
    const httpLayer = mockOfflineHttpClient();

    const layer = BinaryResolver.make("/cache-root").pipe(
      Layer.provide(fakeFs.layer),
      Layer.provide(Path.layer),
      Layer.provide(httpLayer),
      Layer.provide(spawner.layer),
    );

    return Effect.gen(function* () {
      const resolver = yield* BinaryResolver;
      const spec: BinarySpec = { service: "postgrest", version: postgrestVersion };

      const error = yield* resolver.resolveWithMetadata(spec).pipe(Effect.flip);

      expect(error).toBeInstanceOf(DownloadError);
    }).pipe(Effect.provide(layer));
  });
});
