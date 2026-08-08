import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { LegacyPgDeltaDatabaseEndpoint } from "./legacy-pgdelta-engine.service.ts";
import {
  legacyParsePgDeltaNextEndpoint,
  legacyPgDeltaNextIsolatedShadowPlanOptions,
} from "./legacy-pgdelta-engine.next.layer.ts";
import { LegacyPgDeltaEngineError } from "./legacy-pgdelta-engine.service.ts";

describe("legacyPgDeltaNextIsolatedShadowPlanOptions", () => {
  it("uses the isolated full-baseline mode shared by both declarative planner entrypoints", () => {
    expect(legacyPgDeltaNextIsolatedShadowPlanOptions).toEqual({
      isolatedShadow: true,
      seedAssumedSchemas: false,
    });
  });
});

describe("legacyParsePgDeltaNextEndpoint", () => {
  it("fails malformed explicit URLs through the typed error channel and redacts passwords", () => {
    const endpoint = {
      kind: "database",
      ref: "postgresql://postgres:supersecret@[/postgres",
      connectOptions: { isLocal: false, dnsResolver: "native" },
    } satisfies LegacyPgDeltaDatabaseEndpoint;

    const error = Effect.runSync(legacyParsePgDeltaNextEndpoint(endpoint).pipe(Effect.flip));

    expect(error).toBeInstanceOf(LegacyPgDeltaEngineError);
    expect(error.message).toBe("failed to parse Postgres connection string for pg-delta");
    expect(error.cause).toBe("postgresql://postgres:***@[/postgres");
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

    expect(Effect.runSync(legacyParsePgDeltaNextEndpoint(endpoint))).toBe(connection);
  });
});
