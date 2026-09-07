import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LegacyPgDeltaDatabaseEndpoint } from "./legacy-pgdelta-engine.service.ts";
import { legacyParsePgDeltaNextEndpoint } from "./legacy-pgdelta-engine.next.layer.ts";
import { LegacyPgDeltaEngineError } from "./legacy-pgdelta-engine.service.ts";

describe("legacyParsePgDeltaNextEndpoint", () => {
  it("fails malformed explicit URLs through the typed error channel and redacts passwords", () => {
    const endpoint = {
      kind: "database",
      ref: "postgresql://postgres:supersecret@[/postgres",
      connectOptions: { isLocal: false, dnsResolver: "native" },
    } satisfies LegacyPgDeltaDatabaseEndpoint;

    const error = Effect.runSync(legacyParsePgDeltaNextEndpoint(endpoint, {}).pipe(Effect.flip));

    expect(error).toBeInstanceOf(LegacyPgDeltaEngineError);
    expect(error.message).toBe("failed to parse Postgres connection string for pg-delta");
    expect(error.cause).toBe("postgresql://postgres:[REDACTED]@[/postgres");
  });

  it("redacts a password containing @, :, and / rather than leaking a fragment", () => {
    // The previous inline `/:[^:@/]+@/` regex matched nothing here and surfaced the
    // raw URL; the shared redactor anchors on the last `@` before the authority
    // terminator and over-redacts instead (CWE-209).
    const endpoint = {
      kind: "database",
      ref: "postgresql://postgres:p@ss:word/x@[/postgres",
      connectOptions: { isLocal: false, dnsResolver: "native" },
    } satisfies LegacyPgDeltaDatabaseEndpoint;

    const error = Effect.runSync(legacyParsePgDeltaNextEndpoint(endpoint, {}).pipe(Effect.flip));

    expect(String(error.cause)).not.toContain("ss:word/x");
    expect(String(error.cause)).toContain("[REDACTED]");
  });

  it("uses a supplied parsed connection without reparsing the display ref", () => {
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
    } satisfies LegacyPgDeltaDatabaseEndpoint;

    expect(Effect.runSync(legacyParsePgDeltaNextEndpoint(endpoint, {}))).toBe(connection);
  });

  it("fills a passwordless endpoint from the project .env when the shell doesn't set it", () => {
    const endpoint = {
      kind: "database",
      ref: "postgres://user@host:5432/db",
      connectOptions: { isLocal: false, dnsResolver: "native" },
    } satisfies LegacyPgDeltaDatabaseEndpoint;

    const conn = Effect.runSync(
      legacyParsePgDeltaNextEndpoint(endpoint, { PGPASSWORD: "from-project" }),
    );

    expect(conn?.password).toBe("from-project");
  });

  describe("shell env precedence", () => {
    const ORIGINAL_PGPASSWORD = process.env.PGPASSWORD;

    beforeEach(() => {
      process.env.PGPASSWORD = "from-shell";
    });

    afterEach(() => {
      if (ORIGINAL_PGPASSWORD === undefined) delete process.env.PGPASSWORD;
      else process.env.PGPASSWORD = ORIGINAL_PGPASSWORD;
    });

    it("prefers the shell-set PGPASSWORD over the project .env value", () => {
      const endpoint = {
        kind: "database",
        ref: "postgres://user@host:5432/db",
        connectOptions: { isLocal: false, dnsResolver: "native" },
      } satisfies LegacyPgDeltaDatabaseEndpoint;

      const conn = Effect.runSync(
        legacyParsePgDeltaNextEndpoint(endpoint, { PGPASSWORD: "from-project" }),
      );

      expect(conn?.password).toBe("from-shell");
    });
  });
});
