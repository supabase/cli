import { describe, expect, it } from "vitest";

import { DbConnectError } from "../../../command-internal/db-connection.errors.ts";
import { pgDeltaNextEngineError } from "./pgdelta-engine.next.layer.ts";
import { PgDeltaEngineError } from "./pgdelta-engine.service.ts";
import { PgDeltaNextError } from "./pgdelta-next-adapter.service.ts";

describe("pg-delta next engine errors", () => {
  it("finds connection suggestions nested in adapter failures", () => {
    const cause = new DbConnectError({
      message: "failed to connect to postgres",
      suggestion: "Retry with --dns-resolver https.",
    });
    const adapterError = new PgDeltaNextError({
      operation: "diff",
      message: "Database diff failed",
      cause,
    });

    const error = pgDeltaNextEngineError(adapterError);
    expect(error).toBeInstanceOf(PgDeltaEngineError);
    expect(error.message).toBe("Database diff failed");
    expect(error.suggestion).toBe("Retry with --dns-resolver https.");
    expect(error.cause).toBe(adapterError);
  });

  it("preserves structured diagnostics from adapter failures", () => {
    const diagnostics: NonNullable<PgDeltaNextError["diagnostics"]> = [
      {
        code: "stuck_statement",
        severity: "error",
        message: "schemas/app/tables/members.sql: function does not exist",
        context: { rounds: 6 },
      },
    ];
    const adapterError = new PgDeltaNextError({
      operation: "declarativePlan",
      message: "Declarative schema planning failed",
      cause: new Error("shadow load failed"),
      diagnostics,
    });

    expect(pgDeltaNextEngineError(adapterError)).toEqual(
      new PgDeltaEngineError({
        message: "Declarative schema planning failed",
        cause: adapterError,
        diagnostics,
      }),
    );
  });
});
