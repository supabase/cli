import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildServicesForTest } from "../tests/helpers/buildServices.ts";

describe("provisioned postgres", () => {
  it("excludes postgres-init when postgres.provisioned is true", async () => {
    const services = await buildServicesForTest({ postgres: { provisioned: true } });
    expect(services.map((s) => s.name)).not.toContain("postgres-init");
  });

  it("includes postgres-init by default", async () => {
    const services = await buildServicesForTest({});
    expect(services.map((s) => s.name)).toContain("postgres-init");
  });

  it("drops -c runtime args after the micro profile config is installed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "stack-micro-profile-"));
    try {
      writeFileSync(join(dataDir, "postgresql.conf"), "include_if_exists = 'micro.conf'\n");
      const services = await buildServicesForTest({
        mode: "native",
        postgres: { dataDir, provisioned: true, profile: "micro" },
      });
      const pg = services.find((s) => s.name === "postgres");
      expect(pg?.args?.join(" ")).not.toContain("wal_level=logical");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps -c runtime args on the default profile", async () => {
    const services = await buildServicesForTest({});
    const pg = services.find((s) => s.name === "postgres");
    expect(pg?.args?.join(" ")).toContain("wal_level=logical");
  });
});
