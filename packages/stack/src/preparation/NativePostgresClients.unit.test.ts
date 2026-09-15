import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- unit fixture writes a fake artifact tree on disk.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- temp root for the fake artifact tree.
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- join fixture paths.
import { join } from "node:path";
import { catalogReleaseFor, targetForPlatform } from "../model/WorkloadCatalog.ts";
import { cachedPostgresArtifactRoot, nativePostgresClientBinDir } from "./NativePostgresClients.ts";

const layer = NodeServices.layer;

describe("nativePostgresClientBinDir", () => {
  it.effect("returns bin when the extra client exists", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "native-pg-clients-"));
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "pg_dump"), "");
      expect(yield* nativePostgresClientBinDir(root, "pg_dump")).toBe(bin);
      expect(yield* nativePostgresClientBinDir(root, "psql")).toBeUndefined();
    }).pipe(Effect.provide(layer)),
  );
});

describe("cachedPostgresArtifactRoot", () => {
  it.effect("returns undefined when the slim tree is absent", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "native-pg-cache-"));
      expect(yield* cachedPostgresArtifactRoot(root)).toBeUndefined();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("returns the cache root when the slim tree exists", () =>
    Effect.gen(function* () {
      const cacheRoot = mkdtempSync(join(tmpdir(), "native-pg-cache-"));
      const release = catalogReleaseFor("database:database");
      const target = targetForPlatform({ os: process.platform, arch: process.arch });
      expect(release).toBeDefined();
      if (release === undefined || target === undefined) return;
      const root = join(cacheRoot, "slim-services", "postgres", release.version, target);
      mkdirSync(root, { recursive: true });
      expect(yield* cachedPostgresArtifactRoot(cacheRoot)).toBe(root);
    }).pipe(Effect.provide(layer)),
  );
});
