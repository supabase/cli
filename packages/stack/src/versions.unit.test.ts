import { describe, expect, it } from "vitest";
import {
  readVersionManifestFromDockerfile,
  syncDefaultVersionsSource,
} from "../scripts/sync-versions-from-dockerfile.ts";
import {
  DEFAULT_VERSIONS,
  diffPinnedAndAvailableVersions,
  dockerImageForService,
  fillServiceVersionManifest,
  normalizeServiceVersion,
  SERVICE_NAMES,
  type VersionManifest,
} from "./versions.ts";
import { SERVICE_CATALOG } from "./ServiceCatalog.ts";

const sampleDockerfile = `
FROM supabase/postgres:17.0.0.1 AS pg
FROM library/kong:2.8.1 AS kong
FROM axllent/mailpit:v1.2.3 AS mailpit
FROM postgrest/postgrest:v14.0 AS postgrest
FROM supabase/postgres-meta:v0.90.0 AS pgmeta
FROM supabase/studio:2026.01.01-sha-abcdef0 AS studio
FROM darthsim/imgproxy:v3.8.0 AS imgproxy
FROM supabase/edge-runtime:v1.70.0 AS edgeruntime
FROM timberio/vector:0.50.0-alpine AS vector
FROM supabase/supavisor:2.1.0 AS supavisor
FROM supabase/gotrue:v2.100.0 AS gotrue
FROM supabase/realtime:v2.100.0 AS realtime
FROM supabase/storage-api:v1.50.0 AS storage
FROM supabase/logflare:1.40.0 AS logflare
FROM supabase/migra:3.0.1663481299 AS migra
`;

describe("syncDefaultVersionsSource", () => {
  it("rewrites the DEFAULT_VERSIONS block from Dockerfile versions", () => {
    const source = SERVICE_NAMES.map(
      (service) => `  ${JSON.stringify(service)}: {
    name: ${JSON.stringify(service)},
    configKey: "example",
    defaultVersion: "old",
  },`,
    ).join("\n");

    const updated = syncDefaultVersionsSource(
      source,
      readVersionManifestFromDockerfile(sampleDockerfile),
    );

    expect(updated).toContain(
      'name: "postgres",\n    configKey: "example",\n    defaultVersion: "17.0.0.1"',
    );
    expect(updated).toContain(
      'name: "edge-runtime",\n    configKey: "example",\n    defaultVersion: "v1.70.0"',
    );
    expect(updated).toContain(
      'name: "mailpit",\n    configKey: "example",\n    defaultVersion: "v1.2.3"',
    );
    expect(updated).not.toContain('defaultVersion: "old"');
  });

  it("fails when a required Dockerfile image alias is missing", () => {
    expect(() =>
      readVersionManifestFromDockerfile("FROM supabase/postgres:17.6.1.139 AS pg\n"),
    ).toThrow("Missing Dockerfile versions for:");
  });

  it("fails when the Dockerfile contains an unexpected image alias", () => {
    expect(() =>
      readVersionManifestFromDockerfile(
        `${sampleDockerfile}\nFROM supabase/example:1.0.0 AS example\n`,
      ),
    ).toThrow("Unknown Dockerfile image alias 'example'.");
  });
});

describe("dockerImageForService", () => {
  it("defines artifact capabilities for every stack service", () => {
    expect(Object.keys(SERVICE_CATALOG).sort()).toEqual([...SERVICE_NAMES].sort());
  });

  it("returns correct image for postgres", () => {
    expect(dockerImageForService("postgres", DEFAULT_VERSIONS.postgres)).toBe(
      `ghcr.io/supabase/cli/postgres:${DEFAULT_VERSIONS.postgres}`,
    );
  });

  it("returns correct image for postgrest (with v prefix)", () => {
    expect(dockerImageForService("postgrest", DEFAULT_VERSIONS.postgrest)).toBe(
      `ghcr.io/supabase/cli/postgrest:${DEFAULT_VERSIONS.postgrest}`,
    );
  });

  it("returns correct image for auth (with v prefix)", () => {
    expect(dockerImageForService("auth", DEFAULT_VERSIONS.auth)).toBe(
      `ghcr.io/supabase/cli/auth:${DEFAULT_VERSIONS.auth}`,
    );
  });

  it("returns correct image for edge-runtime (with v prefix)", () => {
    expect(dockerImageForService("edge-runtime", DEFAULT_VERSIONS["edge-runtime"])).toBe(
      `ghcr.io/supabase/cli/edge-runtime:${DEFAULT_VERSIONS["edge-runtime"]}`,
    );
  });

  it("uses canonical GHCR for every service", () => {
    expect(dockerImageForService("imgproxy", DEFAULT_VERSIONS.imgproxy)).toBe(
      `ghcr.io/supabase/cli/imgproxy:${DEFAULT_VERSIONS.imgproxy}`,
    );
  });

  it("uses the upstream mirror repositories for vector and pooler", () => {
    expect(dockerImageForService("vector", DEFAULT_VERSIONS.vector)).toBe(
      `ghcr.io/supabase/vector:${DEFAULT_VERSIONS.vector}`,
    );
    expect(dockerImageForService("pooler", DEFAULT_VERSIONS.pooler)).toBe(
      "ghcr.io/supabase/supavisor:2.9.10",
    );
  });

  it("preserves upstream mirror repositories for explicit vector and pooler versions", () => {
    expect(dockerImageForService("vector", "0.52.0-alpine")).toBe(
      "ghcr.io/supabase/vector:0.52.0-alpine",
    );
    expect(dockerImageForService("pooler", "2.9.6")).toBe("ghcr.io/supabase/supavisor:2.9.6");
  });

  it("publishes native slim-services artifacts for every service", () => {
    expect(SERVICE_CATALOG.imgproxy).toMatchObject({
      runtimeSupport: "native-preferred",
      artifact: { docker: { repository: "imgproxy" }, native: expect.any(Object) },
    });
    expect(SERVICE_CATALOG.mailpit).toMatchObject({
      runtimeSupport: "native-preferred",
      artifact: { docker: { repository: "mailpit" }, native: expect.any(Object) },
    });
    expect(SERVICE_CATALOG.vector).toMatchObject({
      runtimeSupport: "native-preferred",
      artifact: { docker: { repository: "vector" }, native: expect.any(Object) },
    });
  });
});

describe("normalizeServiceVersion", () => {
  it("preserves frozen leading v tags", () => {
    expect(normalizeServiceVersion("postgrest", "v14.5")).toBe("v14.5");
    expect(normalizeServiceVersion("auth", "v2.188.0")).toBe("v2.188.0");
    expect(normalizeServiceVersion("edge-runtime", "v1.73.0")).toBe("v1.73.0");
  });

  it("normalizes bare versions for services with v-prefixed catalog releases", () => {
    expect(normalizeServiceVersion("mailpit", "1.30.2")).toBe("v1.30.2");
    expect(normalizeServiceVersion("imgproxy", "3.8.0")).toBe("v3.8.0");
    expect(normalizeServiceVersion("mailpit", "V1.30.2")).toBe("v1.30.2");
  });

  it("passes through other services unchanged", () => {
    expect(normalizeServiceVersion("postgres", "17.6.1.090")).toBe("17.6.1.090");
  });

  it("normalizes a prefixed pgmeta override to its catalog tag", () => {
    expect(normalizeServiceVersion("pgmeta", "v0.98.0")).toBe("0.98.0");
    expect(normalizeServiceVersion("pgmeta", "V0.98.0")).toBe("0.98.0");
    expect(dockerImageForService("pgmeta", normalizeServiceVersion("pgmeta", "v0.98.0"))).toBe(
      "ghcr.io/supabase/cli/pgmeta:v0.98.0",
    );
  });
});

describe("fillServiceVersionManifest", () => {
  it("fills missing versions with defaults", () => {
    const result = fillServiceVersionManifest({ postgres: "17.4.1.045" });
    expect(result.postgres).toBe("17.4.1.045");
    expect(result.postgrest).toBe(DEFAULT_VERSIONS.postgrest);
    expect(result.auth).toBe(DEFAULT_VERSIONS.auth);
    expect(result["edge-runtime"]).toBe(DEFAULT_VERSIONS["edge-runtime"]);
  });

  it("returns all defaults when given empty input", () => {
    const result = fillServiceVersionManifest({});
    expect(result).toEqual(DEFAULT_VERSIONS);
  });
});

describe("diffPinnedAndAvailableVersions", () => {
  it("returns empty when versions match", () => {
    expect(diffPinnedAndAvailableVersions(DEFAULT_VERSIONS, DEFAULT_VERSIONS)).toEqual([]);
  });

  it("returns diffs for changed versions", () => {
    const candidate: VersionManifest = { ...DEFAULT_VERSIONS, auth: "2.190.0" };
    const result = diffPinnedAndAvailableVersions(DEFAULT_VERSIONS, candidate);
    expect(result).toEqual([
      { service: "auth", pinnedVersion: DEFAULT_VERSIONS.auth, availableVersion: "2.190.0" },
    ]);
  });
});
