import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { ServiceEndpoint } from "./Recipe.ts";
import * as Pooler from "./Pooler.ts";
import { selection } from "../../tests/pins.ts";

describe("Pooler environment", () => {
  it.effect("caps Supavisor's BEAM port table", () =>
    Effect.gen(function* () {
      const env = yield* Pooler.makeSpec().env(
        {
          service: "pooler",
          pin: selection.pooler,
          config: { databaseUrl: "postgresql://supabase_admin:postgres@db.internal:5432/postgres" },
        },
        new Map(),
        true,
      );

      expect(env).toMatchObject({ ERL_MAX_PORTS: "65536" });
    }),
  );
});

describe("native Pooler readiness output", () => {
  it.effect("requires the selected HTTP port on a successful endpoint bind line", () =>
    Effect.sync(() => {
      const readinessOutput = Pooler.makeSpec().nativeReadinessOutput;
      const endpoints: ReadonlyMap<string, ServiceEndpoint> = new Map([
        ["http", { kind: "tcp" as const, host: "127.0.0.1", port: 4000 }],
      ]);

      expect(
        readinessOutput?.(
          "Running SupavisorWeb.Endpoint at http://127.0.0.1:4000 (http)",
          endpoints,
        ),
      ).toBe(true);
      expect(
        readinessOutput?.(
          "Running SupavisorWeb.Endpoint at http://127.0.0.1:4000 (http) failed, port already in use",
          endpoints,
        ),
      ).toBe(false);
      expect(
        readinessOutput?.(
          "Running SupavisorWeb.Endpoint at http://127.0.0.1:40001 (http)",
          endpoints,
        ),
      ).toBe(false);
    }),
  );
});
