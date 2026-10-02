import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { analyticsDatabase } from "./LogflareStorage.ts";

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
