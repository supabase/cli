import { describe, expect, it } from "vitest";

import { LegacyDbConnectError } from "../../../shared/legacy-db-connection.errors.ts";
import { legacyPgDeltaNextEngineError } from "./legacy-pgdelta-engine.next.layer.ts";
import { LegacyPgDeltaEngineError } from "./legacy-pgdelta-engine.service.ts";
import { LegacyPgDeltaNextError } from "./legacy-pgdelta-next-adapter.service.ts";

describe("pg-delta next engine errors", () => {
  it("preserves database connection suggestions when wrapping failures", () => {
    const cause = new LegacyDbConnectError({
      message: "failed to connect to postgres",
      suggestion: "Retry with --dns-resolver https.",
    });

    expect(legacyPgDeltaNextEngineError(cause)).toEqual(
      new LegacyPgDeltaEngineError({
        message: "failed to connect to postgres",
        suggestion: "Retry with --dns-resolver https.",
        cause,
      }),
    );
  });

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

    expect(legacyPgDeltaNextEngineError(adapterError).suggestion).toBe(
      "Retry with --dns-resolver https.",
    );
  });

  it("does not wrap an existing engine error again", () => {
    const error = new LegacyPgDeltaEngineError({ message: "blocked", cause: "diagnostic" });
    expect(legacyPgDeltaNextEngineError(error)).toBe(error);
  });
});
