import { afterEach, describe, expect, it } from "vitest";

import {
  legacyEdgeRuntimeId,
  legacyIsPgDeltaDebugEnabled,
  legacyIsPostgresURL,
} from "./legacy-pgdelta.ts";

describe("legacyIsPostgresURL", () => {
  it("recognizes postgres:// and postgresql:// schemes", () => {
    expect(legacyIsPostgresURL("postgres://x")).toBe(true);
    expect(legacyIsPostgresURL("postgresql://x")).toBe(true);
    expect(legacyIsPostgresURL("supabase/.temp/catalog.json")).toBe(false);
    expect(legacyIsPostgresURL("")).toBe(false);
  });
});

describe("legacyEdgeRuntimeId", () => {
  it("names the deno-cache volume per project", () => {
    expect(legacyEdgeRuntimeId("my-ref")).toBe("supabase_edge_runtime_my-ref");
  });
});

describe("legacyIsPgDeltaDebugEnabled", () => {
  const prev = process.env["PGDELTA_DEBUG"];
  afterEach(() => {
    if (prev === undefined) delete process.env["PGDELTA_DEBUG"];
    else process.env["PGDELTA_DEBUG"] = prev;
  });

  it("is true for 1/true/yes (case-insensitive, trimmed)", () => {
    for (const value of ["1", "true", "YES", "  True  "]) {
      process.env["PGDELTA_DEBUG"] = value;
      expect(legacyIsPgDeltaDebugEnabled()).toBe(true);
    }
  });

  it("is false otherwise", () => {
    process.env["PGDELTA_DEBUG"] = "0";
    expect(legacyIsPgDeltaDebugEnabled()).toBe(false);
    delete process.env["PGDELTA_DEBUG"];
    expect(legacyIsPgDeltaDebugEnabled()).toBe(false);
  });
});
