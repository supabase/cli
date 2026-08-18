import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { BinaryResolver } from "./BinaryResolver.ts";
import {
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
) => {
  const source = join(root, "source");
  const archive = join(root, "postgrest.tar.zst");
  rmSync(source, { recursive: true, force: true });
  mkdirSync(join(source, "bin"), { recursive: true });
  if (includePostgrest) {
    writeFileSync(join(source, "bin", "postgrest"), "#!/bin/sh\necho postgrest\n");
  }
  execFileSync("tar", ["--zstd", "-cf", archive, "-C", source, "."]);
  return { archive: readFileSync(archive), manifestOverride };
};

const makeTraversalFixture = (root: string) => {
  const source = join(root, "traversal-source");
  const archive = join(root, "postgrest-traversal.tar.zst");
  rmSync(source, { recursive: true, force: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(join(root, "outside.txt"), "must not extract\n");
  execFileSync("tar", ["--zstd", "-cf", archive, "-C", source, "../outside.txt"]);
  return { archive: readFileSync(archive), manifestOverride: {} };
};

const makeEscapingSymlinkFixture = (root: string) => {
  const source = join(root, "symlink-source");
  const archive = join(root, "postgrest-symlink.tar.zst");
  rmSync(source, { recursive: true, force: true });
  mkdirSync(join(source, "bin"), { recursive: true });
  symlinkSync("/bin/sh", join(source, "bin/postgrest"));
  execFileSync("tar", ["--zstd", "-cf", archive, "-C", source, "."]);
  return { archive: readFileSync(archive), manifestOverride: {} };
};

const makeResolverLayer = (
  cacheRoot: string,
  fixture: ReturnType<typeof makeFixture>,
  options: { readonly checksum?: string } = {},
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
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            `${hash}  postgrest-${DEFAULT_VERSIONS.postgrest}-${process.platform === "darwin" ? "darwin-arm64" : "linux-amd64"}.tar.zst\n`,
            { status: 200 },
          ),
        );
      }
      return HttpClientResponse.fromWeb(request, new Response(fixture.archive, { status: 200 }));
    }),
  );
  return BinaryResolver.make(cacheRoot).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(NodeServices.layer),
  );
};

describe("BinaryResolver slim-services installer", () => {
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
});
