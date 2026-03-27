import { describe, expect, it } from "vitest";
import { DEFAULT_VERSIONS } from "./versions.ts";
import { planStackVersions } from "./version-plan.ts";

describe("planStackVersions", () => {
  it("fills the candidate baseline from linked versions and defaults", () => {
    expect(
      planStackVersions({
        candidateBaseline: {
          postgres: "17.6.1.090",
          postgrest: "v14.5",
          auth: "v2.187.0",
        },
      }),
    ).toMatchObject({
      candidateBaseline: {
        ...DEFAULT_VERSIONS,
        postgres: "17.6.1.090",
        postgrest: "14.5",
        auth: "2.187.0",
      },
      pinnedBaseline: {
        ...DEFAULT_VERSIONS,
        postgres: "17.6.1.090",
        postgrest: "14.5",
        auth: "2.187.0",
      },
    });
  });

  it("applies flag overrides over local overrides without changing the pinned baseline", () => {
    expect(
      planStackVersions({
        candidateBaseline: {
          postgres: "17.6.1.090",
          postgrest: "v14.5",
          auth: "v2.187.0",
        },
        localOverrides: {
          auth: "v2.180.0",
          storage: "1.40.0",
        },
        flagOverrides: {
          auth: "v2.170.0",
          postgres: "17.4.1.045",
        },
      }),
    ).toMatchObject({
      runtimeVersions: {
        ...DEFAULT_VERSIONS,
        postgres: "17.4.1.045",
        postgrest: "14.5",
        auth: "2.170.0",
        storage: "1.40.0",
      },
      activeOverrides: [
        { service: "postgres", version: "17.4.1.045", source: "flag" },
        { service: "auth", version: "2.170.0", source: "flag" },
        { service: "storage", version: "1.40.0", source: "local" },
      ],
    });
  });

  it("uses the pinned baseline to compute available updates and fingerprints", () => {
    expect(
      planStackVersions({
        candidateBaseline: {
          auth: "v2.188.1",
          storage: "v1.43.3",
        },
        pinnedBaseline: {
          ...DEFAULT_VERSIONS,
          auth: "2.188.0-rc.15",
          storage: "1.41.8",
        },
      }),
    ).toMatchObject({
      availableUpdates: [
        {
          service: "auth",
          pinnedVersion: "2.188.0-rc.15",
          availableVersion: "2.188.1",
        },
        {
          service: "storage",
          pinnedVersion: "1.41.8",
          availableVersion: "1.43.3",
        },
      ],
      updateFingerprint: "auth:2.188.0-rc.15->2.188.1|storage:1.41.8->1.43.3",
    });
  });
});
