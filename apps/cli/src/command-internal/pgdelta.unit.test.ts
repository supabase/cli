import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";

import { withConfigEnv, withEmptyConfigEnv } from "../../tests/helpers/command-mocks.ts";
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
  it.effect("is true for 1/true/yes (case-insensitive, trimmed)", () =>
    Effect.gen(function* () {
      for (const value of ["1", "true", "YES", "  True  "]) {
        expect(yield* withConfigEnv({ PGDELTA_DEBUG: value }, isPgDeltaDebugEnabled)).toBe(true);
      }
    }),
  );

  it.effect("is false otherwise", () =>
    Effect.gen(function* () {
      expect(yield* withConfigEnv({ PGDELTA_DEBUG: "0" }, isPgDeltaDebugEnabled)).toBe(false);
      expect(yield* withEmptyConfigEnv(isPgDeltaDebugEnabled)).toBe(false);
    }),
  );

  it.effect("is false when PGDELTA_DEBUG cannot be resolved", () =>
    Effect.gen(function* () {
      expect(yield* isPgDeltaDebugEnabled).toBe(false);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.make(() =>
            Effect.fail(new ConfigProvider.SourceError({ message: "injected" })),
          ),
        ),
      ),
    ),
  );
});
