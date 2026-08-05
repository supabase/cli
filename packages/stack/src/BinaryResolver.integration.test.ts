import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { afterEach } from "vitest";
import { BinaryResolver } from "./BinaryResolver.ts";
import { DownloadError } from "./errors.ts";
import { detectPlatform } from "./Platform.ts";
import { nativeReleaseForService } from "./ServiceArtifacts.ts";
import { DEFAULT_VERSIONS } from "./versions.ts";

const tempRoots: string[] = [];

const makeTempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "stack-binary-resolver-"));
  tempRoots.push(root);
  return root;
};

const makeArchive = (root: string): Uint8Array => {
  const source = join(root, "source");
  const archive = join(root, "auth.tar.gz");
  execFileSync("mkdir", ["-p", source]);
  writeFileSync(join(source, "auth"), "#!/bin/sh\necho auth\n");
  execFileSync("tar", ["czf", archive, "-C", source, "."]);
  return readFileSync(archive);
};

const makeResolverLayer = (cacheRoot: string, archive: Uint8Array, onRequest: () => void) => {
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      onRequest();
      return HttpClientResponse.fromWeb(request, new Response(archive, { status: 200 }));
    }),
  );
  return BinaryResolver.make(cacheRoot).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(NodeServices.layer),
  );
};

const makeUnavailableResolverLayer = (cacheRoot: string) => {
  const client = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })),
    ),
  );
  return BinaryResolver.make(cacheRoot).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(NodeServices.layer),
  );
};

const authCachePath = (cacheRoot: string) =>
  Effect.gen(function* () {
    const platform = yield* detectPlatform;
    const release = nativeReleaseForService("auth", DEFAULT_VERSIONS.auth, platform);
    if (release === undefined) {
      return yield* Effect.die(`unsupported test platform: ${platform.os}-${platform.arch}`);
    }
    return BinaryResolver.cachePath(join(cacheRoot, "bin"), {
      service: "auth",
      provider: release.provider,
      version: DEFAULT_VERSIONS.auth,
      assetName: release.assetName,
    });
  });

const legacyAuthCachePath = (cacheRoot: string) =>
  Effect.gen(function* () {
    const platform = yield* detectPlatform;
    const release = nativeReleaseForService("auth", DEFAULT_VERSIONS.auth, platform);
    if (release === undefined) {
      return yield* Effect.die(`unsupported test platform: ${platform.os}-${platform.arch}`);
    }
    return join(cacheRoot, "bin", "auth", DEFAULT_VERSIONS.auth, release.assetName);
  });

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("BinaryResolver cache publication", () => {
  it.live("publishes one complete cache entry for concurrent resolvers", () => {
    const root = makeTempRoot();
    const archive = makeArchive(root);
    let requestCount = 0;
    const layer = makeResolverLayer(root, archive, () => {
      requestCount += 1;
    });

    return Effect.gen(function* () {
      const resolver = yield* BinaryResolver;
      const results = yield* Effect.all(
        [
          resolver.resolveWithMetadata({ service: "auth", version: DEFAULT_VERSIONS.auth }),
          resolver.resolveWithMetadata({ service: "auth", version: DEFAULT_VERSIONS.auth }),
        ],
        { concurrency: "unbounded" },
      );

      expect(requestCount).toBe(2);
      expect(results.filter((result) => result.downloaded)).toHaveLength(1);
      expect(results[0]?.path).toBe(results[1]?.path);
      expect(readFileSync(join(results[0]!.path, "auth"), "utf8")).toContain("echo auth");
      expect(readFileSync(join(results[0]!.path, ".complete"), "utf8")).toContain(
        "github.com/supabase/auth",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("reuses a complete cache from the legacy layout without downloading", () => {
    const root = makeTempRoot();
    const layer = makeUnavailableResolverLayer(root);

    return Effect.gen(function* () {
      const resolver = yield* BinaryResolver;
      const legacyCacheDir = yield* legacyAuthCachePath(root);
      mkdirSync(legacyCacheDir, { recursive: true });
      writeFileSync(join(legacyCacheDir, "auth"), "legacy auth binary");

      const result = yield* resolver.resolveWithMetadata({
        service: "auth",
        version: DEFAULT_VERSIONS.auth,
      });

      expect(result).toEqual({ path: legacyCacheDir, downloaded: false });
    }).pipe(Effect.provide(layer));
  });

  it.live("preserves a markerless provider cache when replacement download fails", () => {
    const root = makeTempRoot();
    const layer = makeUnavailableResolverLayer(root);

    return Effect.gen(function* () {
      const resolver = yield* BinaryResolver;
      const cacheDir = yield* authCachePath(root);
      const legacyBinary = join(cacheDir, "auth");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(legacyBinary, "legacy auth binary");

      const error = yield* resolver
        .resolveWithMetadata({ service: "auth", version: DEFAULT_VERSIONS.auth })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(DownloadError);
      expect(readFileSync(legacyBinary, "utf8")).toBe("legacy auth binary");
    }).pipe(Effect.provide(layer));
  });

  it.live("replaces an incomplete provider cache after staging succeeds", () => {
    const root = makeTempRoot();
    const archive = makeArchive(root);
    const layer = makeResolverLayer(root, archive, () => {});

    return Effect.gen(function* () {
      const resolver = yield* BinaryResolver;
      const cacheDir = yield* authCachePath(root);
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, ".complete"), "orphaned marker");

      const result = yield* resolver.resolveWithMetadata({
        service: "auth",
        version: DEFAULT_VERSIONS.auth,
      });

      expect(result).toEqual({ path: cacheDir, downloaded: true });
      expect(readFileSync(join(cacheDir, "auth"), "utf8")).toContain("echo auth");
      expect(readFileSync(join(cacheDir, ".complete"), "utf8")).toContain(
        "github.com/supabase/auth",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("reaps stale staging directories even when the artifact is cached", () => {
    const root = makeTempRoot();
    const archive = makeArchive(root);
    const layer = makeResolverLayer(root, archive, () => {});

    return Effect.gen(function* () {
      const resolver = yield* BinaryResolver;
      const spec = { service: "auth", version: DEFAULT_VERSIONS.auth } as const;
      const first = yield* resolver.resolveWithMetadata(spec);
      const staleStaging = join(dirname(first.path), `.${basename(first.path)}.partial-abandoned`);
      mkdirSync(staleStaging);
      writeFileSync(join(staleStaging, "partial"), "partial artifact");
      const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1_000);
      utimesSync(staleStaging, staleTime, staleTime);

      const second = yield* resolver.resolveWithMetadata(spec);

      expect(second.downloaded).toBe(false);
      expect(existsSync(staleStaging)).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});
