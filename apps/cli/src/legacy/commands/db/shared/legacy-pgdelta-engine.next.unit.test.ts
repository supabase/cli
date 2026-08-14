import { describe, expect, it } from "vitest";

import { LegacyDbConnectError } from "../../../shared/legacy-db-connection.errors.ts";
import { legacyPgDeltaNextEngineError } from "./legacy-pgdelta-engine.next.layer.ts";
import { LegacyPgDeltaEngineError } from "./legacy-pgdelta-engine.service.ts";
import { LegacyPgDeltaNextError } from "./legacy-pgdelta-next-adapter.service.ts";

describe("pg-delta next engine errors", () => {
  it("finds connection suggestions nested in adapter failures", () => {
    const cause = new LegacyDbConnectError({
      message: "failed to connect to postgres",
      suggestion: "Retry with --dns-resolver https.",
    });
    const adapterError = new LegacyPgDeltaNextError({
      operation: "diff",
      message: "Database diff failed",
      cause,
    });

    const error = legacyPgDeltaNextEngineError(adapterError);
    expect(error).toBeInstanceOf(LegacyPgDeltaEngineError);
    expect(error.message).toBe("Database diff failed");
    expect(error.suggestion).toBe("Retry with --dns-resolver https.");
    expect(error.cause).toBe(adapterError);
  });

  it("preserves structured diagnostics from adapter failures", () => {
    const diagnostics: NonNullable<LegacyPgDeltaNextError["diagnostics"]> = [
      {
        code: "stuck_statement",
        severity: "error",
        message: "schemas/app/tables/members.sql: function does not exist",
        context: { rounds: 6 },
      },
    ];
    const adapterError = new LegacyPgDeltaNextError({
      operation: "declarativePlan",
      message: "Declarative schema planning failed",
      cause: new Error("shadow load failed"),
      diagnostics,
    });

    expect(legacyPgDeltaNextEngineError(adapterError)).toEqual(
      new LegacyPgDeltaEngineError({
        message: "Declarative schema planning failed",
        cause: adapterError,
        diagnostics,
      }),
    );
  });
});
