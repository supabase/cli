import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { analyticsDatabase } from "./LogflareStorage.ts";

it.effect("reaches a configured Analytics database at its URL's address", () =>
  Effect.gen(function* () {
    expect(
      yield* analyticsDatabase("postgresql://db.example.test:6543/postgres", undefined),
    ).toEqual({
      host: "db.example.test",
      port: 6543,
      database: "_supabase",
      username: "supabase_admin",
      password: "postgres",
    });
  }),
);

it.effect("reaches a bound Analytics database at its endpoint with the URL's credentials", () =>
  Effect.gen(function* () {
    expect(
      yield* analyticsDatabase("postgresql://supabase_admin:secret@db-runtime:5432/_supabase", {
        kind: "unix",
        path: "/tmp/stack-socket",
        port: 5432,
      }),
    ).toEqual({
      host: "/tmp/stack-socket",
      port: 5432,
      database: "_supabase",
      username: "supabase_admin",
      password: "secret",
    });
  }),
);
