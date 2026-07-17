import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configureExtensionPreload, planExtensionPreload } from "./extensionPreload.ts";
import { readPreloadLibraries } from "./pgconf.ts";

describe("planExtensionPreload", () => {
  it("no-ops for extensions that do not need preload", () => {
    expect(planExtensionPreload("pgvector", [])).toEqual({ action: "none" });
  });
  it("no-ops when already preloaded", () => {
    expect(planExtensionPreload("pg_cron", ["pg_cron"])).toEqual({ action: "none" });
  });
  it("appends the required library otherwise", () => {
    expect(planExtensionPreload("pg_cron", ["pg_net"])).toEqual({
      action: "update",
      libraries: ["pg_net", "pg_cron"],
    });
  });
});

describe("configureExtensionPreload", () => {
  it("owns idempotent preload persistence for running and suspended callers", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "extension-preload-"));
    try {
      await writeFile(join(dataDir, "postgresql.conf"), "# stock config\n");
      await expect(configureExtensionPreload(dataDir, "pg_cron")).resolves.toBe("updated");
      await expect(configureExtensionPreload(dataDir, "pg_cron")).resolves.toBe("unchanged");
      await expect(configureExtensionPreload(dataDir, "vector")).resolves.toBe("not-required");
      await expect(readPreloadLibraries(dataDir)).resolves.toEqual(["pg_cron"]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
