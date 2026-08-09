import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../../../shared/telemetry/error-actionability.ts";
import { NoBranchNameError } from "./errors.ts";

describe("NoBranchNameError actionability", () => {
  it("classifies a declined-prompt cancellation as user-cancelled", () => {
    const result = classifyCliErrorActionability(
      new NoBranchNameError({
        detail: "Branch creation cancelled.",
        suggestion: "Provide a branch name: `supabase branches create <name>`",
        cancelled: true,
      }),
    );
    expect(result.error_kind).toBe("user_cancelled");
    expect(result.error_category).toBe("cancelled");
    expect(result.error_fingerprint).toBe("tag:NoBranchNameError");
  });

  it("classifies a genuinely missing branch name as provide-flags", () => {
    const result = classifyCliErrorActionability(
      new NoBranchNameError({
        detail: "No branch name provided and no git branch detected.",
        suggestion: "Provide a branch name: `supabase branches create <name>`",
      }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("invalid_input");
    expect(result.suggestion_type).toBe("provide_flags");
    expect(result.error_fingerprint).toBe("tag:NoBranchNameError");
  });
});
