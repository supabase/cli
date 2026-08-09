import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePins } from "./pins.ts";

// Reads the real CLI sources: if the pin format in the Go config templates
// changes shape, the generator must fail loudly rather than bundle against
// stale images.
const CLI_GO = join(import.meta.dirname, "..", "..", "..", "..", "apps", "cli-go");

const load = async () => ({
  dockerfile: await readFile(join(CLI_GO, "pkg", "config", "templates", "Dockerfile"), "utf8"),
  constantsGo: await readFile(join(CLI_GO, "pkg", "config", "constants.go"), "utf8"),
});

describe("parsePins", () => {
  it("resolves the pg17 pins from the CLI's Dockerfile template", async () => {
    const sources = await load();
    const pins = parsePins({ lineage: "pg17", ...sources });
    expect(pins.pg).toMatch(/^supabase\/postgres:17\./);
    expect(pins.realtime).toMatch(/^supabase\/realtime:v/);
    expect(pins.storage).toMatch(/^supabase\/storage-api:v/);
    expect(pins.auth).toMatch(/^supabase\/gotrue:v/);
  });

  it("resolves the frozen pg15 lineage from constants.go", async () => {
    const sources = await load();
    const pins = parsePins({ lineage: "pg15", ...sources });
    expect(pins.pg).toMatch(/^supabase\/postgres:15\./);
  });

  it("lets an explicit postgres image override the pin", async () => {
    const sources = await load();
    const pins = parsePins({
      lineage: "pg17",
      ...sources,
      postgresImageOverride: "supabase/postgres:17.9.9.999",
    });
    expect(pins.pg).toBe("supabase/postgres:17.9.9.999");
  });
});
