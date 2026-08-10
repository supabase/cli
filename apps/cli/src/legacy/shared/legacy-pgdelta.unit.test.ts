import { afterEach, describe, expect, it } from "vitest";

import {
  legacyEdgeRuntimeId,
  legacyIsPgDeltaDebugEnabled,
  legacyIsPostgresURL,
  legacyPgDeltaBinds,
  legacyPgDeltaContainerRef,
  legacyPgDeltaNpmRegistryOption,
} from "./legacy-pgdelta.ts";

describe("legacyIsPostgresURL", () => {
  it("recognizes postgres:// and postgresql:// schemes", () => {
    expect(legacyIsPostgresURL("postgres://x")).toBe(true);
    expect(legacyIsPostgresURL("postgresql://x")).toBe(true);
    expect(legacyIsPostgresURL("supabase/.temp/catalog.json")).toBe(false);
    expect(legacyIsPostgresURL("")).toBe(false);
  });
});

describe("legacyPgDeltaContainerRef", () => {
  it("passes through empty strings and Postgres URLs unchanged", () => {
    expect(legacyPgDeltaContainerRef("")).toBe("");
    expect(legacyPgDeltaContainerRef("postgresql://u:p@h:5432/db")).toBe(
      "postgresql://u:p@h:5432/db",
    );
  });

  it("maps a relative catalog path under /workspace", () => {
    expect(legacyPgDeltaContainerRef("supabase/.temp/catalog.json")).toBe(
      "/workspace/supabase/.temp/catalog.json",
    );
  });

  it("normalizes Windows separators to forward slashes", () => {
    expect(legacyPgDeltaContainerRef("supabase\\.temp\\catalog.json")).toBe(
      "/workspace/supabase/.temp/catalog.json",
    );
  });
});

describe("legacyEdgeRuntimeId", () => {
  it("names the deno-cache volume per project", () => {
    expect(legacyEdgeRuntimeId("my-ref")).toBe("supabase_edge_runtime_my-ref");
  });
});

describe("legacyPgDeltaBinds", () => {
  it("binds the deno cache volume and the cwd workspace", () => {
    expect(legacyPgDeltaBinds("ref", "/proj")).toEqual([
      "supabase_edge_runtime_ref:/root/.cache/deno:rw",
      "/proj:/workspace",
    ]);
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

describe("legacyPgDeltaNpmRegistryOption", () => {
  const prev = process.env["PGDELTA_NPM_REGISTRY"];
  afterEach(() => {
    if (prev === undefined) delete process.env["PGDELTA_NPM_REGISTRY"];
    else process.env["PGDELTA_NPM_REGISTRY"] = prev;
  });

  it("returns no option when unset in both the shell and the project .env", () => {
    delete process.env["PGDELTA_NPM_REGISTRY"];
    expect(legacyPgDeltaNpmRegistryOption({})).toEqual({});
  });

  it("falls back to the project .env when the shell env is unset (Go's godotenv.Load parity)", () => {
    delete process.env["PGDELTA_NPM_REGISTRY"];
    const npm = legacyPgDeltaNpmRegistryOption({
      PGDELTA_NPM_REGISTRY: "https://registry.example.com",
    });
    expect(npm.extraFiles).toEqual([
      { name: ".npmrc", content: "@supabase:registry=https://registry.example.com\n" },
    ]);
    expect(npm.extraEnv).toEqual({
      PGDELTA_NPM_REGISTRY: "https://registry.example.com",
      NPM_CONFIG_REGISTRY: "https://registry.example.com",
    });
  });

  it("prefers the shell env over the project .env (shell presence wins)", () => {
    process.env["PGDELTA_NPM_REGISTRY"] = "https://shell.example.com";
    const npm = legacyPgDeltaNpmRegistryOption({
      PGDELTA_NPM_REGISTRY: "https://dotenv.example.com",
    });
    expect(npm.extraEnv?.["PGDELTA_NPM_REGISTRY"]).toBe("https://shell.example.com");
  });

  it("treats a whitespace-only value as unset", () => {
    delete process.env["PGDELTA_NPM_REGISTRY"];
    expect(legacyPgDeltaNpmRegistryOption({ PGDELTA_NPM_REGISTRY: "   " })).toEqual({});
  });
});
