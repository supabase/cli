import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";

import { withConfigEnv } from "../../../../tests/helpers/command-mocks.ts";

import type { PgDeltaDatabaseEndpoint } from "./pgdelta-engine.service.ts";
import { parsePgDeltaNextEndpoint } from "./pgdelta-engine.next.layer.ts";
import { PgDeltaEngineError } from "./pgdelta-engine.service.ts";

const endpointLayer = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnvRecord({}, { preserveEmptyStrings: true })),
);

describe("parsePgDeltaNextEndpoint", () => {
  it.effect(
    "fails malformed explicit URLs through the typed error channel and redacts passwords",
    () =>
      Effect.gen(function* () {
        const endpoint = {
          kind: "database",
          ref: "postgresql://postgres:supersecret@[/postgres",
          connectOptions: { isLocal: false, dnsResolver: "native" },
        } satisfies PgDeltaDatabaseEndpoint;

        const error = yield* parsePgDeltaNextEndpoint(endpoint, {}).pipe(Effect.flip);

        expect(error).toBeInstanceOf(PgDeltaEngineError);
        expect(error.message).toBe("failed to parse Postgres connection string for pg-delta");
        expect(error.cause).toBe("postgresql://postgres:[REDACTED]@[/postgres");
      }).pipe(Effect.provide(endpointLayer)),
  );

  it.effect("redacts a password containing @, :, and / rather than leaking a fragment", () =>
    Effect.gen(function* () {
      // The previous inline `/:[^:@/]+@/` regex matched nothing here and surfaced the
      // raw URL; the shared redactor anchors on the last `@` before the authority
      // terminator and over-redacts instead (CWE-209).
      const endpoint = {
        kind: "database",
        ref: "postgresql://postgres:p@ss:word/x@[/postgres",
        connectOptions: { isLocal: false, dnsResolver: "native" },
      } satisfies PgDeltaDatabaseEndpoint;

      const error = yield* parsePgDeltaNextEndpoint(endpoint, {}).pipe(Effect.flip);

      expect(String(error.cause)).not.toContain("ss:word/x");
      expect(String(error.cause)).toContain("[REDACTED]");
    }).pipe(Effect.provide(endpointLayer)),
  );

  it.effect("uses a supplied parsed connection without reparsing the display ref", () =>
    Effect.gen(function* () {
      const connection = {
        host: "localhost",
        port: 5432,
        user: "postgres",
        password: "secret",
        database: "postgres",
      };
      const endpoint = {
        kind: "database",
        ref: "malformed-display-ref",
        connection,
        connectOptions: { isLocal: true, dnsResolver: "native" },
      } satisfies PgDeltaDatabaseEndpoint;

      expect(yield* parsePgDeltaNextEndpoint(endpoint, {})).toBe(connection);
    }).pipe(Effect.provide(endpointLayer)),
  );

  it.effect(
    "fills a passwordless endpoint from the project .env when the shell doesn't set it",
    () =>
      Effect.gen(function* () {
        const endpoint = {
          kind: "database",
          ref: "postgres://user@host:5432/db",
          connectOptions: { isLocal: false, dnsResolver: "native" },
        } satisfies PgDeltaDatabaseEndpoint;

        const conn = yield* parsePgDeltaNextEndpoint(endpoint, { PGPASSWORD: "from-project" });

        expect(conn?.password).toBe("from-project");
      }).pipe(Effect.provide(endpointLayer)),
  );

  describe("shell env precedence", () => {
    it.effect("prefers the shell-set PGPASSWORD over the project .env value", () =>
      Effect.gen(function* () {
        const endpoint = {
          kind: "database",
          ref: "postgres://user@host:5432/db",
          connectOptions: { isLocal: false, dnsResolver: "native" },
        } satisfies PgDeltaDatabaseEndpoint;

        const conn = yield* withConfigEnv(
          { PGPASSWORD: "from-shell" },
          parsePgDeltaNextEndpoint(endpoint, { PGPASSWORD: "from-project" }),
        );

        expect(conn?.password).toBe("from-shell");
      }).pipe(Effect.provide(endpointLayer)),
    );
  });
});
