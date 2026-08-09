import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { loadBundleStore } from "./BundleStore.ts";
import { resolveBundle } from "./Resolution.ts";

const rootManifest = {
  formatVersion: 1,
  applyOrder: ["realtime", "storage", "auth"],
  lineages: ["pg17"],
};

const bundleManifest = {
  formatVersion: 1,
  lineage: "pg17",
  service: "auth",
  serviceVersion: "v2.195.0",
  serviceImage: "supabase/gotrue:v2.195.0",
  apply: [
    { file: "schema.sql", transactionMode: "transactional" },
    { file: "data.sql", transactionMode: "transactional" },
  ],
  trackingTables: ["auth.schema_migrations"],
  excluded: [],
  tuple: {
    postgresImage: "supabase/postgres:17.6.1.158",
    serviceRole: "supabase_auth_admin",
    env: { GOTRUE_DB_DRIVER: "postgres" },
    orioledb: false,
  },
  predecessors: { realtime: "v2.124.2", storage: "v1.68.10" },
  pgDeltaVersion: "1.0.0-alpha.33",
  generatorVersion: "0.1.0",
};

describe("loadBundleStore", () => {
  let rootDir: string;

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sql-baselines-"));
    await writeFile(join(rootDir, "manifest.json"), JSON.stringify(rootManifest));
    const bundleDir = join(rootDir, "pg17", "auth", "v2.195.0");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "manifest.json"), JSON.stringify(bundleManifest));
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("loads a bundle tree and resolves pins against it", async () => {
    const store = await Effect.runPromise(loadBundleStore(rootDir));
    expect(store.root.applyOrder).toEqual(["realtime", "storage", "auth"]);
    const resolution = resolveBundle(store.index, {
      lineage: "pg17",
      service: "auth",
      version: "v2.195.0",
    });
    expect(resolution._tag).toBe("Hit");
  });

  it("fails loudly on a malformed bundle manifest instead of dropping it", async () => {
    const brokenDir = join(rootDir, "pg17", "auth", "v0.0.0-broken");
    await mkdir(brokenDir, { recursive: true });
    await writeFile(join(brokenDir, "manifest.json"), JSON.stringify({ formatVersion: 2 }));
    const exit = await Effect.runPromiseExit(loadBundleStore(rootDir));
    expect(Exit.isFailure(exit)).toBe(true);
    await rm(brokenDir, { recursive: true, force: true });
  });
});
