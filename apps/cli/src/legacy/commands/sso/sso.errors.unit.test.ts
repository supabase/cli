import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../../../shared/telemetry/error-actionability.ts";
import { LegacySsoMetadataUrlNetworkError } from "./sso.errors.ts";

describe("LegacySsoMetadataUrlNetworkError actionability", () => {
  it("classifies a failed user-supplied --metadata-url as a flag input problem", () => {
    const result = classifyCliErrorActionability(
      new LegacySsoMetadataUrlNetworkError({ message: "failed to fetch metadata url: timeout" }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("invalid_input");
    expect(result.suggestion_type).toBe("provide_flags");
  });
});
