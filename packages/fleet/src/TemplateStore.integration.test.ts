import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baseTemplateKey } from "./PodManifest.ts";
import { TemplateStore } from "./TemplateStore.ts";

// Requires postgres binaries in the local cache; opt-in via env, since the first
// run downloads a real postgres release (~minutes) and boots it.
const POSTGRES_VERSION = "17.6.1.143";

describe.skipIf(!process.env.FLEET_PG_TESTS)("TemplateStore", () => {
  it("builds a base template once and reuses it", async () => {
    const root = await mkdtemp(join(tmpdir(), "templates-"));
    const store = new TemplateStore(root);
    const first = await store.ensureBaseTemplate(POSTGRES_VERSION);
    expect(first).toContain(baseTemplateKey(POSTGRES_VERSION));
    // PGDATA got the micro profile
    const conf = await readFile(join(first, "postgresql.conf"), "utf8");
    expect(conf).toContain("include_if_exists = 'micro.conf'");

    const started = Date.now();
    const second = await store.ensureBaseTemplate(POSTGRES_VERSION);
    expect(second).toBe(first);
    expect(Date.now() - started).toBeLessThan(1000); // cache hit, no rebuild
  }, 600_000);

  it("falls back to the base template when no services are enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "templates-"));
    const store = new TemplateStore(root);
    const base = await store.ensureBaseTemplate(POSTGRES_VERSION);
    const warm = await store.ensureWarmTemplate({ postgres: POSTGRES_VERSION }, []);
    expect(warm).toBe(base);
  }, 600_000);
});
