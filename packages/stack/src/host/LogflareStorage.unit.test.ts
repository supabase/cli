import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { analyticsDatabase } from "./LogflareStorage.ts";

it.effect("reaches a bound Analytics database at its endpoint with the URL's credentials", () =>
  Effect.gen(function* () {
    const { url } = yield* analyticsDatabase(
      "postgresql://supabase_admin:secret@db-runtime:5432/_supabase",
      { kind: "unix", path: "/tmp/stack-socket", port: 5432 },
    );

    expect(url).toBe(
      "postgresql://supabase_admin:secret@db-runtime:5432/_supabase?host=%2Ftmp%2Fstack-socket",
    );
  }),
);

it.effect("keeps the TLS settings of Analytics' database URL", () =>
  Effect.gen(function* () {
    const { url } = yield* analyticsDatabase(
      "postgresql://admin:secret@db.example.com:6543/postgres?sslmode=verify-full&sslrootcert=/ca.pem",
      undefined,
    );

    expect(url).toBe(
      "postgresql://admin:secret@db.example.com:6543/_supabase?sslmode=verify-full&sslrootcert=/ca.pem",
    );
  }),
);
