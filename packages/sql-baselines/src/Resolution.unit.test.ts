import { describe, expect, it } from "vitest";
import type { BundleManifest, PgLineage, ServiceName } from "./Manifest.ts";
import { makeBundleIndex, planReplay, resolveBundle } from "./Resolution.ts";

const manifest = (
  service: ServiceName,
  serviceVersion: string,
  lineage: PgLineage = "pg17",
): BundleManifest => ({
  formatVersion: 1,
  lineage,
  service,
  serviceVersion,
  serviceImage: `supabase/${service}:${serviceVersion}`,
  apply: [
    { file: "schema.sql", transactionMode: "transactional" },
    { file: "data.sql", transactionMode: "transactional" },
  ],
  trackingTables: [`${service}.schema_migrations`],
  excluded: [],
  tuple: {
    postgresImage: "supabase/postgres:17.6.1.158",
    serviceRole: "supabase_admin",
    env: {},
    orioledb: false,
  },
  predecessors: {},
  pgDeltaVersion: "1.0.0-alpha.33",
  generatorVersion: "0.1.0",
});

describe("resolveBundle", () => {
  const index = makeBundleIndex([manifest("realtime", "v2.124.2"), manifest("auth", "v2.195.0")]);

  it("resolves an exact (lineage, service, version) pin to ordered files", () => {
    const resolution = resolveBundle(index, {
      lineage: "pg17",
      service: "realtime",
      version: "v2.124.2",
    });
    expect(resolution._tag).toBe("Hit");
    if (resolution._tag === "Hit") {
      expect(resolution.dir).toBe("pg17/realtime/v2.124.2");
      expect(resolution.files.map((f) => f.file)).toEqual([
        "pg17/realtime/v2.124.2/schema.sql",
        "pg17/realtime/v2.124.2/data.sql",
      ]);
    }
  });

  it("misses on an unbundled version so the consumer can fall back to container jobs", () => {
    const resolution = resolveBundle(index, {
      lineage: "pg17",
      service: "realtime",
      version: "v2.999.0",
    });
    expect(resolution).toEqual({
      _tag: "Miss",
      query: { lineage: "pg17", service: "realtime", version: "v2.999.0" },
    });
  });

  it("misses on a different lineage even when the service version is bundled", () => {
    const resolution = resolveBundle(index, {
      lineage: "pg15",
      service: "realtime",
      version: "v2.124.2",
    });
    expect(resolution._tag).toBe("Miss");
  });
});

describe("planReplay", () => {
  const index = makeBundleIndex([
    manifest("realtime", "v2.124.2"),
    manifest("storage", "v1.68.10"),
    manifest("auth", "v2.195.0"),
  ]);

  it("plans all enabled services in canonical order", () => {
    const steps = planReplay(index, "pg17", {
      realtime: "v2.124.2",
      storage: "v1.68.10",
      auth: "v2.195.0",
    });
    expect(steps.map((s) => s.service)).toEqual(["realtime", "storage", "auth"]);
    expect(steps.every((s) => s.resolution._tag === "Hit")).toBe(true);
  });

  it("skips services without a pin (disabled in config)", () => {
    const steps = planReplay(index, "pg17", { auth: "v2.195.0" });
    expect(steps.map((s) => s.service)).toEqual(["auth"]);
  });

  it("degrades every step after a miss because bundles are sequential diffs", () => {
    const steps = planReplay(index, "pg17", {
      realtime: "v9.9.9",
      storage: "v1.68.10",
      auth: "v2.195.0",
    });
    expect(steps.map((s) => s.resolution._tag)).toEqual(["Miss", "Miss", "Miss"]);
  });

  it("keeps earlier hits when only a later service misses", () => {
    const steps = planReplay(index, "pg17", {
      realtime: "v2.124.2",
      storage: "v1.68.10",
      auth: "v9.9.9",
    });
    expect(steps.map((s) => s.resolution._tag)).toEqual(["Hit", "Hit", "Miss"]);
  });
});
