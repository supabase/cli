import { afterEach, describe, expect, it } from "vitest";

import { edgeRuntimeId, isPgDeltaDebugEnabled, isPostgresURL } from "./pgdelta.ts";

describe("isPostgresURL", () => {
  it("recognizes postgres:// and postgresql:// schemes", () => {
    expect(isPostgresURL("postgres://x")).toBe(true);
    expect(isPostgresURL("postgresql://x")).toBe(true);
    expect(isPostgresURL("supabase/.temp/catalog.json")).toBe(false);
    expect(isPostgresURL("")).toBe(false);
  });
});

describe("edgeRuntimeId", () => {
  it("names the deno-cache volume per project", () => {
    expect(edgeRuntimeId("my-ref")).toBe("supabase_edge_runtime_my-ref");
  });
});

describe("isPgDeltaDebugEnabled", () => {
  const prev = process.env["PGDELTA_DEBUG"];
  afterEach(() => {
    if (prev === undefined) delete process.env["PGDELTA_DEBUG"];
    else process.env["PGDELTA_DEBUG"] = prev;
  });

  it("is true for 1/true/yes (case-insensitive, trimmed)", () => {
    for (const value of ["1", "true", "YES", "  True  "]) {
      process.env["PGDELTA_DEBUG"] = value;
      expect(isPgDeltaDebugEnabled()).toBe(true);
    }
  });

  it("is false otherwise", () => {
    process.env["PGDELTA_DEBUG"] = "0";
    expect(isPgDeltaDebugEnabled()).toBe(false);
    delete process.env["PGDELTA_DEBUG"];
    expect(isPgDeltaDebugEnabled()).toBe(false);
  });
});
