import { describe, expect, it } from "vitest";

import { legacyServiceContainerIds, localDbContainerId } from "./legacy-docker-ids.ts";
import { LEGACY_SERVICE_CATALOG } from "./legacy-service-catalog.ts";

describe("LEGACY_SERVICE_CATALOG", () => {
  it("has exactly 13 excludable entries and 1 non-excludable entry (Postgres)", () => {
    const withExcludeKey = LEGACY_SERVICE_CATALOG.filter((entry) => entry.excludeKey !== undefined);
    const withoutExcludeKey = LEGACY_SERVICE_CATALOG.filter(
      (entry) => entry.excludeKey === undefined,
    );
    expect(withExcludeKey).toHaveLength(13);
    expect(withoutExcludeKey).toHaveLength(1);
    expect(withoutExcludeKey[0]?.service).toBe("postgres");
  });

  it("has no duplicate containerSuffix, excludeKey, or startOrder values", () => {
    const suffixes = LEGACY_SERVICE_CATALOG.map((entry) => entry.containerSuffix);
    const excludeKeys = LEGACY_SERVICE_CATALOG.filter(
      (entry) => entry.excludeKey !== undefined,
    ).map((entry) => entry.excludeKey);
    const startOrders = LEGACY_SERVICE_CATALOG.map((entry) => entry.startOrder);

    expect(new Set(suffixes).size).toBe(suffixes.length);
    expect(new Set(excludeKeys).size).toBe(excludeKeys.length);
    expect(new Set(startOrders).size).toBe(startOrders.length);
  });

  it("uses startOrder values 1-14 with no gaps", () => {
    const startOrders = LEGACY_SERVICE_CATALOG.map((entry) => entry.startOrder).sort(
      (a, b) => a - b,
    );
    expect(startOrders).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
  });

  it("is ordered by ascending startOrder", () => {
    const startOrders = LEGACY_SERVICE_CATALOG.map((entry) => entry.startOrder);
    expect(startOrders).toEqual([...startOrders].sort((a, b) => a - b));
  });

  it("has no duplicate service keys", () => {
    const services = LEGACY_SERVICE_CATALOG.map((entry) => entry.service);
    expect(new Set(services).size).toBe(services.length);
  });

  it("every non-Postgres containerSuffix matches a legacyServiceContainerIds suffix", () => {
    // legacyServiceContainerIds bakes its suffixes into the returned container
    // ids, so recover them by stripping the shared "supabase_" prefix and
    // "_<projectId>" suffix for a fixed project id.
    const projectId = "catalog-cross-check";
    const containerIds = legacyServiceContainerIds(projectId);
    const suffixesFromContainerIds = containerIds.map((id) =>
      id.replace(/^supabase_/, "").replace(new RegExp(`_${projectId}$`), ""),
    );

    for (const entry of LEGACY_SERVICE_CATALOG) {
      if (entry.service === "postgres") continue;
      expect(suffixesFromContainerIds).toContain(entry.containerSuffix);
    }
  });

  it("Postgres's containerSuffix matches localDbContainerId's suffix", () => {
    const projectId = "catalog-cross-check";
    const postgresEntry = LEGACY_SERVICE_CATALOG.find((entry) => entry.service === "postgres");
    expect(postgresEntry?.containerSuffix).toBe("db");
    expect(localDbContainerId(projectId)).toBe(
      `supabase_${postgresEntry?.containerSuffix}_${projectId}`,
    );
  });
});
