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

it.effect("drops host and TLS parameters meant for the runtime's address of a bound database", () =>
  Effect.gen(function* () {
    const { url } = yield* analyticsDatabase(
      "postgresql://supabase_admin:secret@db-runtime:5432/postgres?host=/run/sock&sslmode=verify-full&sslrootcert=/ca.pem&application_name=analytics",
      { kind: "tcp", host: "127.0.0.1", port: 54322 },
    );

    expect(url).toBe(
      "postgresql://supabase_admin:secret@127.0.0.1:54322/_supabase?application_name=analytics",
    );
  }),
);

it.effect("keeps the TLS settings of Analytics' own database URL with libpq's meaning", () =>
  Effect.gen(function* () {
    const { url } = yield* analyticsDatabase(
      "postgresql://admin:secret@db.example.com:6543/postgres?sslmode=require&sslrootcert=/ca.pem",
      undefined,
    );

    expect(url).toBe(
      "postgresql://admin:secret@db.example.com:6543/_supabase?sslmode=require&sslrootcert=%2Fca.pem&uselibpqcompat=true",
    );
  }),
);
