import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Layer, Path, PlatformError, Sink, Stream } from "effect";
import { HttpClient } from "effect/unstable/http";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ChildProcessSpawner } from "effect/unstable/process";
import { BinaryResolver, type BinarySpec } from "./BinaryResolver.ts";
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

  const isWithin = (candidatePath: string, rootPath: string): boolean =>
    candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);

  const addAncestorDirs = (childPath: string): void => {
    const segments = childPath.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < segments.length - 1; i++) {
      current += `/${segments[i]}`;
      dirs.add(current);
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
          addAncestorDirs(dirPath);
        }),
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
