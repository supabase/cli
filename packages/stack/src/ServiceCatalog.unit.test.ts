import { describe, expect, it } from "vitest";
import { DEFAULT_VERSIONS, SERVICE_CATALOG, SERVICE_NAMES } from "./ServiceCatalog.ts";

describe("ServiceCatalog", () => {
  it("derives exhaustive iteration and defaults from catalog entries", () => {
    expect(SERVICE_NAMES).toEqual(Object.keys(SERVICE_CATALOG));
    expect(Object.keys(DEFAULT_VERSIONS)).toEqual(SERVICE_NAMES);

    for (const service of SERVICE_NAMES) {
      expect(SERVICE_CATALOG[service].name).toBe(service);
      expect(DEFAULT_VERSIONS[service]).toBe(SERVICE_CATALOG[service].defaultVersion);
    }
  });

  it("references only catalog services in activation relationships", () => {
    const knownServices = new Set(SERVICE_NAMES);
    for (const service of SERVICE_NAMES) {
      const { activates, owns } = SERVICE_CATALOG[service].activation;
      expect([...activates, ...owns].every((related) => knownServices.has(related))).toBe(true);
    }
  });
});
