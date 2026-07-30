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
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ChildProcessSpawner } from "effect/unstable/process";
import { BinaryResolver, type BinarySpec } from "./BinaryResolver.ts";
import { detectPlatform, postgrestAssetName } from "./Platform.ts";
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
      remove: (targetPath) => Effect.sync(() => removeSubtree(targetPath)),
      rename: (oldPath, newPath) => {
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
});
