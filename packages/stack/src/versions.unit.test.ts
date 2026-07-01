import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  readVersionManifestFromDockerfile,
  syncDefaultVersionsSource,
} from "../scripts/sync-versions-from-dockerfile.ts";
import {
  DEFAULT_VERSIONS,
  diffPinnedAndAvailableVersions,
  dockerImageCandidatesForService,
  dockerImageForService,
  fillServiceVersionManifest,
  normalizeServiceVersion,
  type VersionManifest,
} from "./versions.ts";

const dockerfile = readFileSync(
  new URL("../../../apps/cli-go/pkg/config/templates/Dockerfile", import.meta.url),
  "utf8",
);

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

describe("DEFAULT_VERSIONS", () => {
  it("has all required services", () => {
    expect(DEFAULT_VERSIONS).toHaveProperty("postgres");
    expect(DEFAULT_VERSIONS).toHaveProperty("postgrest");
    expect(DEFAULT_VERSIONS).toHaveProperty("auth");
    expect(DEFAULT_VERSIONS).toHaveProperty("edge-runtime");
  });

  it("versions are non-empty strings", () => {
    expect(typeof DEFAULT_VERSIONS.postgres).toBe("string");
    expect(DEFAULT_VERSIONS.postgres.length).toBeGreaterThan(0);
    expect(typeof DEFAULT_VERSIONS.postgrest).toBe("string");
    expect(DEFAULT_VERSIONS.postgrest.length).toBeGreaterThan(0);
    expect(typeof DEFAULT_VERSIONS.auth).toBe("string");
    expect(DEFAULT_VERSIONS.auth.length).toBeGreaterThan(0);
    expect(typeof DEFAULT_VERSIONS["edge-runtime"]).toBe("string");
    expect(DEFAULT_VERSIONS["edge-runtime"].length).toBeGreaterThan(0);
  });

  it("matches the Dockerfile manifest exposed to Dependabot", () => {
    expect(readVersionManifestFromDockerfile(dockerfile)).toEqual(DEFAULT_VERSIONS);
  });
});

describe("syncDefaultVersionsSource", () => {
  it("rewrites the DEFAULT_VERSIONS block from Dockerfile versions", () => {
    const source = `before
export const DEFAULT_VERSIONS: VersionManifest = {
  postgres: "old",
  postgrest: "old",
  auth: "old",
  "edge-runtime": "old",
  realtime: "old",
  storage: "old",
  imgproxy: "old",
  mailpit: "old",
  pgmeta: "old",
  studio: "old",
  analytics: "old",
  vector: "old",
  pooler: "old",
} as const;
after`;

    expect(syncDefaultVersionsSource(source, readVersionManifestFromDockerfile(sampleDockerfile)))
      .toMatchInlineSnapshot(`
        "before
        export const DEFAULT_VERSIONS: VersionManifest = {
          postgres: "17.0.0.1",
          postgrest: "14.0",
          auth: "2.100.0",
          "edge-runtime": "1.70.0",
          realtime: "2.100.0",
          storage: "1.50.0",
          imgproxy: "v3.8.0",
          mailpit: "v1.2.3",
          pgmeta: "0.90.0",
          studio: "2026.01.01-sha-abcdef0",
          analytics: "1.40.0",
          vector: "0.50.0-alpine",
          pooler: "2.1.0",
        } as const;
        after"
      `);
  });

  it("fails when a required Dockerfile image alias is missing", () => {
    expect(() =>
      readVersionManifestFromDockerfile("FROM supabase/postgres:17.6.1.139 AS pg\n"),
    ).toThrow("Missing Dockerfile versions for:");
  });

  it("fails when the Dockerfile contains an unexpected image alias", () => {
    expect(() =>
      readVersionManifestFromDockerfile(`${dockerfile}\nFROM supabase/example:1.0.0 AS example\n`),
    ).toThrow("Unknown Dockerfile image alias 'example'.");
  });
});

describe("dockerImageForService", () => {
  it("returns correct image for postgres", () => {
    expect(dockerImageForService("postgres", DEFAULT_VERSIONS.postgres)).toBe(
      `public.ecr.aws/supabase/postgres:${DEFAULT_VERSIONS.postgres}`,
    );
  });

  it("returns correct image for postgrest (with v prefix)", () => {
    expect(dockerImageForService("postgrest", DEFAULT_VERSIONS.postgrest)).toBe(
      `public.ecr.aws/supabase/postgrest:v${DEFAULT_VERSIONS.postgrest}`,
    );
  });

  it("returns correct image for auth (with v prefix)", () => {
    expect(dockerImageForService("auth", DEFAULT_VERSIONS.auth)).toBe(
      `public.ecr.aws/supabase/gotrue:v${DEFAULT_VERSIONS.auth}`,
    );
  });

  it("returns correct image for edge-runtime (with v prefix)", () => {
    expect(dockerImageForService("edge-runtime", DEFAULT_VERSIONS["edge-runtime"])).toBe(
      `public.ecr.aws/supabase/edge-runtime:v${DEFAULT_VERSIONS["edge-runtime"]}`,
    );
  });

  it("returns ECR, Docker Hub, and GHCR candidates for Supabase-owned images", () => {
    expect(dockerImageCandidatesForService("auth", DEFAULT_VERSIONS.auth)).toEqual([
      `public.ecr.aws/supabase/gotrue:v${DEFAULT_VERSIONS.auth}`,
      `supabase/gotrue:v${DEFAULT_VERSIONS.auth}`,
      `ghcr.io/supabase/gotrue:v${DEFAULT_VERSIONS.auth}`,
    ]);
  });

  it("does not add fallback registries for third-party images", () => {
    expect(dockerImageCandidatesForService("imgproxy", DEFAULT_VERSIONS.imgproxy)).toEqual([
      `darthsim/imgproxy:${DEFAULT_VERSIONS.imgproxy}`,
    ]);
  });
});

describe("normalizeServiceVersion", () => {
  it("strips v prefix for services with IMAGE_TAG_PREFIX 'v'", () => {
    expect(normalizeServiceVersion("postgrest", "v14.5")).toBe("14.5");
    expect(normalizeServiceVersion("auth", "v2.188.0")).toBe("2.188.0");
    expect(normalizeServiceVersion("edge-runtime", "v1.73.0")).toBe("1.73.0");
  });

  it("ensures v prefix for services whose defaults start with v", () => {
    expect(normalizeServiceVersion("mailpit", "1.30.2")).toBe("v1.30.2");
    expect(normalizeServiceVersion("imgproxy", "3.8.0")).toBe("v3.8.0");
  });

  it("passes through other services unchanged", () => {
    expect(normalizeServiceVersion("postgres", "17.6.1.090")).toBe("17.6.1.090");
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
