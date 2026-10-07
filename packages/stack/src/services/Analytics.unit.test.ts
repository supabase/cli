import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeSpec, type Creation } from "./Analytics.ts";

const creation = (databaseUrl: string): Creation => ({
  service: "analytics",
  config: { databaseUrl, apiKey: "analytics-key" },
});

it.effect("keeps Logflare's events in the internal database it keeps its sources in", () =>
  Effect.gen(function* () {
    const env = yield* makeSpec().env(
      creation("postgresql://reader:se%40cret@db.internal:6543/postgres?sslmode=disable"),
      new Map(),
      true,
    );

    expect(env).toMatchObject({
      DB_HOSTNAME: "db.internal",
      DB_PORT: "6543",
      DB_DATABASE: "_supabase",
      DB_USERNAME: "reader",
      DB_PASSWORD: "se@cret",
      POSTGRES_BACKEND_URL:
        "postgresql://reader:se%40cret@db.internal:6543/_supabase?sslmode=disable",
    });
  }),
);

it.effect("gives Logflare's sources and events the default credentials a URL leaves out", () =>
  Effect.gen(function* () {
    const env = yield* makeSpec().env(
      creation("postgresql://db.internal/_supabase"),
      new Map(),
      true,
    );

    expect(env).toMatchObject({
      DB_USERNAME: "supabase_admin",
      DB_PASSWORD: "postgres",
      POSTGRES_BACKEND_URL: "postgresql://supabase_admin:postgres@db.internal/_supabase",
    });
  }),
);
