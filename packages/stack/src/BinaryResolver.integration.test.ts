import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { zstdCompressSync } from "node:zlib";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Predicate } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { BinaryResolver } from "./BinaryResolver.ts";
import {
  BinaryHostCompatibilityError,
  BinaryManifestError,
  BinaryRuntimeError,
  ChecksumMismatchError,
  DownloadError,
} from "./errors.ts";
import { detectPlatform } from "./Platform.ts";
import { nativeReleaseForService } from "./ServiceCatalog.ts";
import { DEFAULT_VERSIONS } from "./versions.ts";

const makeRoot = (): string => mkdtempSync(join(tmpdir(), "stack-slim-services-"));

const makeFixture = (
  root: string,
  manifestOverride: Record<string, unknown> = {},
  includePostgrest = true,
  paddingBytes = 0,
) => {
  const source = join(root, "source");
  const tar = join(root, "postgrest.tar");
  const archive = join(root, "postgrest.tar.zst");
  rmSync(source, { recursive: true, force: true });
  mkdirSync(join(source, "bin"), { recursive: true });
  if (includePostgrest) {
    writeFileSync(join(source, "bin", "postgrest"), "#!/bin/sh\necho postgrest\n");
  }
  if (paddingBytes > 0) {
    writeFileSync(join(source, "bin", "padding"), Buffer.alloc(paddingBytes));
  }
  execFileSync("tar", ["-cf", tar, "-C", source, "."]);
  writeFileSync(archive, zstdCompressSync(readFileSync(tar)));
  return { archive: readFileSync(archive), manifestOverride };
};

const writeTarOctal = (header: Buffer, offset: number, length: number, value: number): void => {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  header.write(encoded, offset, length, "ascii");
};

const makeTarArchive = (member: string, contents: string): Buffer => {
  const payload = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(member, 0, 100, "utf8");
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, payload.length);
  writeTarOctal(header, 136, 12, 0);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (payload.length % 512)) % 512);
  return Buffer.concat([header, payload, padding, Buffer.alloc(1024)]);
};

const makeTraversalFixture = (root: string) => {
  const archive = join(root, "postgrest-traversal.tar.zst");
  writeFileSync(join(root, "outside.txt"), "must not extract\n");
  writeFileSync(archive, zstdCompressSync(makeTarArchive("../outside.txt", "must not extract\n")));
  return { archive: readFileSync(archive), manifestOverride: {} };
};

const makeEscapingSymlinkFixture = (root: string) => {
  const source = join(root, "symlink-source");
  const tar = join(root, "postgrest-symlink.tar");
  const archive = join(root, "postgrest-symlink.tar.zst");
  rmSync(source, { recursive: true, force: true });
  mkdirSync(join(source, "bin"), { recursive: true });
  symlinkSync("/bin/sh", join(source, "bin/postgrest"));
  execFileSync("tar", ["-cf", tar, "-C", source, "."]);
  writeFileSync(archive, zstdCompressSync(readFileSync(tar)));
  return { archive: readFileSync(archive), manifestOverride: {} };
};

const makeResolverLayer = (
  cacheRoot: string,
  fixture: ReturnType<typeof makeFixture>,
  options: {
    readonly checksum?: string;
    readonly checksumText?: string;
    readonly spawnedCommands?: Array<{ command: string; args: ReadonlyArray<string> }>;
    readonly onChecksumRead?: () => void;
    readonly exitCodeForCommand?: (command: string) => number | undefined;
    readonly transformFileSystem?: (fileSystem: FileSystem.FileSystem) => FileSystem.FileSystem;
  } = {},
) => {
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.url.endsWith(".manifest.json")) {
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              service: "postgrest",
              version: DEFAULT_VERSIONS.postgrest,
              target: process.platform === "darwin" ? "darwin-arm64" : "linux-amd64",
              entrypoint: [],
              cmd: ["/bin/postgrest"],
              runtime_requires: null,
              libc: process.platform === "linux" ? "glibc" : null,
              os_floor:
                process.platform === "linux"
                  ? { kind: "glibc", floor: null, scanned: 1 }
                  : { kind: "macos", floor: null, scanned: 1 },
              ...fixture.manifestOverride,
            }),
            { status: 200 },
          ),
        );
      }
      if (request.url.endsWith("SHA256SUMS")) {
        const hash = options.checksum ?? createHash("sha256").update(fixture.archive).digest("hex");
        const checksumText =
          options.checksumText ??
          `${hash}  postgrest-${DEFAULT_VERSIONS.postgrest}-${process.platform === "darwin" ? "darwin-arm64" : "linux-amd64"}.tar.zst\n`;
        const response = HttpClientResponse.fromWeb(
          request,
          new Response(checksumText, { status: 200 }),
        );
        if (options.onChecksumRead !== undefined) {
          Object.defineProperty(response, "text", {
            value: Effect.sync(() => {
              options.onChecksumRead?.();
              return checksumText;
            }),
          });
        }
        return response;
      }
      return HttpClientResponse.fromWeb(request, new Response(fixture.archive, { status: 200 }));
    }),
  );
  const spawnerLayer =
    options.spawnedCommands === undefined && options.exitCodeForCommand === undefined
      ? NodeServices.layer
      : Layer.effect(
          ChildProcessSpawner.ChildProcessSpawner,
          Effect.gen(function* () {
            const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
            const record = (command: ChildProcess.Command) => {
              if (Predicate.isTagged(command, "StandardCommand")) {
                options.spawnedCommands?.push({
                  command: command.command,
                  args: command.args,
                });
              }
            };
            const spawner = ChildProcessSpawner.make((command) => {
              record(command);
              return delegate.spawn(command);
            });
            return ChildProcessSpawner.ChildProcessSpawner.of({
              ...spawner,
              exitCode: (command) => {
                if (!Predicate.isTagged(command, "StandardCommand")) {
                  return spawner.exitCode(command);
                }
                const exitCode = options.exitCodeForCommand?.(command.command);
                if (exitCode === undefined) return spawner.exitCode(command);
                record(command);
                return Effect.succeed(ChildProcessSpawner.ExitCode(exitCode));
              },
            });
          }),
        ).pipe(Layer.provide(NodeServices.layer));
  const fileSystemLayer =
    options.transformFileSystem === undefined
      ? NodeFileSystem.layer
      : Layer.effect(
          FileSystem.FileSystem,
          Effect.map(FileSystem.FileSystem, options.transformFileSystem),
        ).pipe(Layer.provide(NodeFileSystem.layer));
  return BinaryResolver.make(cacheRoot).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, client),
        spawnerLayer,
        fileSystemLayer,
        NodePath.layer,
      ),
    ),
  );
};

describe("BinaryResolver slim-services installer", () => {
  it.live("keeps the Effect runtime responsive while decompressing an archive", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      try {
        let eventLoopAdvanced = false;
        let advancedBeforeArchiveWrite = false;
        const resolverLayer = makeResolverLayer(
          root,
          makeFixture(root, {}, true, 32 * 1024 * 1024),
          {
            onChecksumRead: () => {
              setImmediate(() => {
                eventLoopAdvanced = true;
              });
            },
            transformFileSystem: (fileSystem) =>
              FileSystem.FileSystem.of({
                ...fileSystem,
                writeFile: (requestedPath, data, options) => {
                  if (requestedPath.endsWith("_download.tar")) {
                    advancedBeforeArchiveWrite = eventLoopAdvanced;
                  }
                  return fileSystem.writeFile(requestedPath, data, options);
                },
              }),
          },
        );

        yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          yield* resolver.resolve({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer));

        expect(advancedBeforeArchiveWrite).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.live("rejects failed binary post-processing before publishing the cache", () =>
    Effect.gen(function* () {
      const commands = [
        ...(process.platform === "win32" ? [] : ["chmod"]),
        ...(process.platform === "darwin" ? ["find"] : []),
      ];
      for (const failedCommand of commands) {
        const root = makeRoot();
        try {
          const resolverLayer = makeResolverLayer(root, makeFixture(root), {
            exitCodeForCommand: (command) => (command === failedCommand ? 73 : undefined),
          });
          const failure = yield* Effect.gen(function* () {
            const resolver = yield* BinaryResolver;
            return yield* resolver.resolve({
              service: "postgrest",
              version: DEFAULT_VERSIONS.postgrest,
            });
          }).pipe(Effect.provide(resolverLayer), Effect.flip);

          expect(failure).toBeInstanceOf(BinaryRuntimeError);
          if (failure instanceof BinaryRuntimeError) {
            expect(failure.detail).toContain("73");
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }),
  );

  it.live("installs a tar.zst archive into an empty cache and reuses it", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      try {
        const fixture = makeFixture(root);
        const resolverLayer = makeResolverLayer(root, fixture);
        const release = nativeReleaseForService(
          "postgrest",
          DEFAULT_VERSIONS.postgrest,
          yield* detectPlatform,
        );
        if (release === undefined) return;
        const result = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          const first = yield* resolver.resolveWithMetadata({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
          const second = yield* resolver.resolveWithMetadata({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
          return { first, second };
        }).pipe(Effect.provide(resolverLayer));
        expect(result.first.downloaded).toBe(true);
        expect(result.second.downloaded).toBe(false);
        expect(readFileSync(join(result.first.path, "bin/postgrest"), "utf8")).toContain(
          "postgrest",
        );
        expect(existsSync(join(result.first.path, ".complete"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.live("rejects a complete cache prepared for an incompatible host", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      try {
        const resolverLayer = makeResolverLayer(root, makeFixture(root));
        const installed = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolve({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer));

        const markerPath = join(installed, ".complete");
        const marker = JSON.parse(readFileSync(markerPath, "utf8"));
        marker.hostCompatibility =
          process.platform === "darwin"
            ? {
                runtimeRequires: null,
                libc: null,
                osFloor: { kind: "macos", floor: "999.0" },
              }
            : {
                runtimeRequires: "glibc",
                libc: "glibc",
                osFloor: { kind: "glibc", floor: "999.0" },
              };
        writeFileSync(markerPath, JSON.stringify(marker));

        const failure = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolve({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer), Effect.flip);

        expect(failure).toBeInstanceOf(BinaryHostCompatibilityError);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.live("fails closed when the manifest host floor is malformed", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      try {
        const fixture = makeFixture(root, {
          os_floor:
            process.platform === "darwin"
              ? { kind: "macos", floor: "not-a-version", scanned: 1 }
              : { kind: "glibc", floor: "not-a-version", scanned: 1 },
        });
        const resolverLayer = makeResolverLayer(root, fixture);
        const failure = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolve({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer), Effect.flip);

        expect(failure).toBeInstanceOf(BinaryHostCompatibilityError);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.live("installs slim archives without requiring an external zstd executable", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      try {
        const spawnedCommands: Array<{ command: string; args: ReadonlyArray<string> }> = [];
        const resolverLayer = makeResolverLayer(root, makeFixture(root), { spawnedCommands });
        yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          yield* resolver.resolve({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer));

        expect(spawnedCommands.some(({ args }) => args.includes("--zstd"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.live("accepts the Mailpit-style glibc runtime requirement", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return;
      const root = makeRoot();
      try {
        const fixture = makeFixture(root, { runtime_requires: "glibc" });
        const resolverLayer = makeResolverLayer(root, fixture);
        const result = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolve({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer));
        expect(existsSync(join(result, "bin/postgrest"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.live("reclaims interrupted staging while preserving complete cache entries", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      try {
        const fixture = makeFixture(root);
        const resolverLayer = makeResolverLayer(root, fixture);
        const release = nativeReleaseForService(
          "postgrest",
          DEFAULT_VERSIONS.postgrest,
          yield* detectPlatform,
        );
        if (release === undefined) return;
        const cacheDir = BinaryResolver.cachePath(join(root, "bin"), {
          service: "postgrest",
          releaseSet: "slim-services",
          version: DEFAULT_VERSIONS.postgrest,
          runtime: "native",
          target: release.target,
        });
        const stale = join(dirname(cacheDir), `.${release.assetName}.partial-interrupted`);
        mkdirSync(stale, { recursive: true });
        const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
        utimesSync(stale, old, old);

        const resolved = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolve({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer));

        expect(existsSync(stale)).toBe(false);
        expect(existsSync(join(resolved, ".complete"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.live("limits stale staging reconciliation to four filesystem operations", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      try {
        const fixture = makeFixture(root);
        const release = nativeReleaseForService(
          "postgrest",
          DEFAULT_VERSIONS.postgrest,
          yield* detectPlatform,
        );
        if (release === undefined) return;
        const cacheDir = BinaryResolver.cachePath(join(root, "bin"), {
          service: "postgrest",
          releaseSet: "slim-services",
          version: DEFAULT_VERSIONS.postgrest,
          runtime: "native",
          target: release.target,
        });
        const stalePrefix = join(dirname(cacheDir), `.${release.assetName}.partial-cap-`);
        const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
        for (let index = 0; index < 5; index += 1) {
          const stalePath = `${stalePrefix}${index}`;
          mkdirSync(stalePath, { recursive: true });
          utimesSync(stalePath, old, old);
        }

        const saturated = yield* Deferred.make<void>();
        const releaseStats = yield* Deferred.make<void>();
        let active = 0;
        let maxActive = 0;
        const resolverLayer = makeResolverLayer(root, fixture, {
          transformFileSystem: (fileSystem) =>
            FileSystem.FileSystem.of({
              ...fileSystem,
              stat: (requestedPath) => {
                if (!requestedPath.startsWith(stalePrefix)) return fileSystem.stat(requestedPath);
                return Effect.acquireUseRelease(
                  Effect.sync(() => {
                    active += 1;
                    maxActive = Math.max(maxActive, active);
                    return active;
                  }).pipe(
                    Effect.tap((current) =>
                      current === 4 ? Deferred.succeed(saturated, undefined) : Effect.void,
                    ),
                  ),
                  () =>
                    Deferred.await(releaseStats).pipe(
                      Effect.andThen(fileSystem.stat(requestedPath)),
                    ),
                  () =>
                    Effect.sync(() => {
                      active -= 1;
                    }),
                );
              },
            }),
        });
        const resolving = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolve({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer), Effect.forkChild({ startImmediately: true }));

        yield* Deferred.await(saturated);
        yield* Effect.yieldNow;
        expect(maxActive).toBe(4);

        yield* Deferred.succeed(releaseStats, undefined);
        yield* Fiber.join(resolving);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.live("replaces caches with invalid identity markers or missing required paths", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      try {
        const fixture = makeFixture(root);
        const resolverLayer = makeResolverLayer(root, fixture);
        const result = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolveWithMetadata({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer));
        expect(result.downloaded).toBe(true);

        const markerPath = join(result.path, ".complete");
        writeFileSync(markerPath, JSON.stringify({ service: "postgrest" }));
        const replacedMarker = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolveWithMetadata({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer));
        expect(replacedMarker.downloaded).toBe(true);
        expect(JSON.parse(readFileSync(markerPath, "utf8"))).toMatchObject({
          service: "postgrest",
          version: DEFAULT_VERSIONS.postgrest,
          runtime: "native",
        });

        rmSync(join(replacedMarker.path, "bin/postgrest"));
        const restoredPath = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolveWithMetadata({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer));
        expect(restoredPath.downloaded).toBe(true);
        expect(existsSync(join(restoredPath.path, "bin/postgrest"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.live("preserves a cache published while another resolver repairs stale state", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      try {
        const fixture = makeFixture(root);
        const resolverLayer = makeResolverLayer(root, fixture);
        const installed = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolveWithMetadata({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer));
        const markerPath = join(installed.path, ".complete");
        writeFileSync(markerPath, JSON.stringify({ service: "postgrest" }));

        const staleMarkerRead = yield* Deferred.make<void>();
        const releaseStaleReader = yield* Deferred.make<void>();
        let markerReads = 0;
        const staleReaderLayer = makeResolverLayer(root, fixture, {
          transformFileSystem: (fileSystem) =>
            FileSystem.FileSystem.of({
              ...fileSystem,
              readFileString: (requestedPath, options) =>
                Effect.gen(function* () {
                  const contents = yield* fileSystem.readFileString(requestedPath, options);
                  if (requestedPath === markerPath) {
                    markerReads += 1;
                    if (markerReads === 2) {
                      yield* Deferred.succeed(staleMarkerRead, undefined);
                      yield* Deferred.await(releaseStaleReader);
                    }
                  }
                  return contents;
                }),
            }),
        });
        const staleReader = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolveWithMetadata({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(staleReaderLayer), Effect.forkChild);
        yield* Deferred.await(staleMarkerRead);

        const publisher = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolveWithMetadata({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(makeResolverLayer(root, fixture)));
        yield* Deferred.succeed(releaseStaleReader, undefined);
        const repaired = yield* Fiber.join(staleReader);

        expect(publisher.downloaded).toBe(true);
        expect(repaired.downloaded).toBe(false);
        expect(repaired.path).toBe(installed.path);
        expect(readFileSync(join(installed.path, "bin/postgrest"), "utf8")).toContain("postgrest");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.live("rejects archive members that escape the private staging directory", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      try {
        const fixture = makeTraversalFixture(root);
        const resolverLayer = makeResolverLayer(root, fixture);
        const failure = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolve({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer), Effect.flip);
        expect(failure).toBeInstanceOf(DownloadError);
        const release = nativeReleaseForService(
          "postgrest",
          DEFAULT_VERSIONS.postgrest,
          yield* detectPlatform,
        );
        if (release !== undefined) {
          const cache = BinaryResolver.cachePath(join(root, "bin"), {
            service: "postgrest",
            releaseSet: "slim-services",
            version: DEFAULT_VERSIONS.postgrest,
            runtime: "native",
            target: release.target,
          });
          expect(existsSync(join(dirname(cache), "outside.txt"))).toBe(false);
          expect(existsSync(join(cache, ".complete"))).toBe(false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.live("rejects archive symlinks that resolve outside private staging", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      try {
        const resolverLayer = makeResolverLayer(root, makeEscapingSymlinkFixture(root));
        const failure = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolve({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer), Effect.flip);
        expect(failure).toBeInstanceOf(BinaryRuntimeError);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.live("rejects checksum and manifest/runtime validation failures", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      try {
        const fixture = makeFixture(root);
        const resolverLayer = makeResolverLayer(root, fixture, { checksum: "0".repeat(64) });
        const checksum = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolve({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer), Effect.flip);
        expect(checksum).toBeInstanceOf(ChecksumMismatchError);

        const manifestLayer = makeResolverLayer(
          root,
          makeFixture(root, {
            target: process.platform === "darwin" ? "linux-amd64" : "darwin-arm64",
          }),
        );
        const manifest = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolve({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(manifestLayer), Effect.flip);
        expect(manifest).toBeInstanceOf(BinaryManifestError);
        expect(manifest).not.toBeInstanceOf(BinaryRuntimeError);

        const unsafeCommandLayer = makeResolverLayer(
          root,
          makeFixture(root, { cmd: ["../bin/postgrest"] }),
        );
        const unsafeCommand = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolve({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(unsafeCommandLayer), Effect.flip);
        expect(unsafeCommand).toBeInstanceOf(BinaryManifestError);

        const runtimeLayer = makeResolverLayer(root, makeFixture(root, {}, false));
        const runtime = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolve({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(runtimeLayer), Effect.flip);
        expect(runtime).toBeInstanceOf(BinaryRuntimeError);
        const release = nativeReleaseForService(
          "postgrest",
          DEFAULT_VERSIONS.postgrest,
          yield* detectPlatform,
        );
        if (release !== undefined) {
          const cache = BinaryResolver.cachePath(join(root, "bin"), {
            service: "postgrest",
            releaseSet: "slim-services",
            version: DEFAULT_VERSIONS.postgrest,
            runtime: "native",
            target: release.target,
          });
          expect(existsSync(join(cache, ".complete"))).toBe(false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.live("fails closed when SHA256SUMS has no entry for the requested archive", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      try {
        const fixture = makeFixture(root);
        const unrelated = createHash("sha256").update(fixture.archive).digest("hex");
        const resolverLayer = makeResolverLayer(root, fixture, {
          checksumText: `${unrelated}  unrelated.sbom.spdx.json\n`,
        });
        const failure = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolve({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer), Effect.flip);

        expect(failure).toBeInstanceOf(BinaryManifestError);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.live("accepts uppercase SHA256SUMS digests", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      try {
        const fixture = makeFixture(root);
        const hash = createHash("sha256").update(fixture.archive).digest("hex").toUpperCase();
        const resolverLayer = makeResolverLayer(root, fixture, { checksum: hash });
        const resolved = yield* Effect.gen(function* () {
          const resolver = yield* BinaryResolver;
          return yield* resolver.resolve({
            service: "postgrest",
            version: DEFAULT_VERSIONS.postgrest,
          });
        }).pipe(Effect.provide(resolverLayer));

        expect(existsSync(join(resolved, "bin/postgrest"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
  );
});
