import { Cause, Data } from "effect";
import { describe, expect, it } from "vitest";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  classifyCliCauseActionability,
  classifyCliErrorActionability,
  ErrorActionabilityId,
} from "./error-actionability.ts";

class DeclaredError extends Data.TaggedError("DeclaredError")<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.authLogin;
  }
}

describe("error actionability", () => {
  it("uses declarations on CLI errors", () => {
    expect(classifyCliErrorActionability(new DeclaredError({ message: "x" })).error_kind).toBe(
      "user_actionable",
    );
  });

  it("classifies causes without exposing raw details", () => {
    const classified = classifyCliCauseActionability(Cause.fail(new Error("boom")));
    expect(classified.error_fingerprint).toMatch(/^error:/);
  });
});
