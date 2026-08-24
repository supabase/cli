import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import {
  legacyEdgeRuntimeId,
  legacyIsPgDeltaDebugEnabled,
  legacyIsPostgresURL,
  legacyPgDeltaBinds,
  legacyPgDeltaContainerRef,
  legacyPgDeltaNpmRegistryOption,
} from "./legacy-pgdelta.ts";
import { makeLegacyViperEnvLayer } from "../../shared/legacy/legacy-viper-env.ts";

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
  it("is true for 1/true/yes (case-insensitive, trimmed)", () => {
    for (const value of ["1", "true", "YES", "  True  "]) {
      expect(legacyIsPgDeltaDebugEnabled({ PGDELTA_DEBUG: value })).toBe(true);
    }
  });

  it("is false otherwise", () => {
    expect(legacyIsPgDeltaDebugEnabled({ PGDELTA_DEBUG: "0" })).toBe(false);
    expect(legacyIsPgDeltaDebugEnabled({})).toBe(false);
  });
});

describe("legacyPgDeltaNpmRegistryOption", () => {
  const resolve = (projectEnv: Record<string, string>, shellEnv: Record<string, string> = {}) =>
    legacyPgDeltaNpmRegistryOption(projectEnv).pipe(
      Effect.provide(
        makeLegacyViperEnvLayer(
          ConfigProvider.fromEnv({ env: shellEnv, preserveEmptyStrings: true }),
        ),
      ),
    );

  it.effect("returns no option when unset in both the shell and the project .env", () =>
    resolve({}).pipe(Effect.map((result) => expect(result).toEqual({}))),
  );

  it.effect(
    "falls back to the project .env when the shell env is unset (Go's godotenv.Load parity)",
    () =>
      resolve({ PGDELTA_NPM_REGISTRY: "https://registry.example.com" }).pipe(
        Effect.tap((npm) =>
          Effect.sync(() => {
            expect(npm.extraFiles).toEqual([
              { name: ".npmrc", content: "@supabase:registry=https://registry.example.com\n" },
            ]);
            expect(npm.extraEnv).toEqual({
              PGDELTA_NPM_REGISTRY: "https://registry.example.com",
              NPM_CONFIG_REGISTRY: "https://registry.example.com",
            });
          }),
        ),
      ),
  );

  it.effect("prefers the shell env over the project .env (shell presence wins)", () =>
    resolve(
      { PGDELTA_NPM_REGISTRY: "https://dotenv.example.com" },
      { PGDELTA_NPM_REGISTRY: "https://shell.example.com" },
    ).pipe(
      Effect.tap((npm) =>
        Effect.sync(() => {
          expect(npm.extraEnv?.["PGDELTA_NPM_REGISTRY"]).toBe("https://shell.example.com");
        }),
      ),
    ),
  );

  it.effect("treats a whitespace-only value as unset", () =>
    resolve({ PGDELTA_NPM_REGISTRY: "   " }).pipe(
      Effect.map((result) => expect(result).toEqual({})),
    ),
  );
});
