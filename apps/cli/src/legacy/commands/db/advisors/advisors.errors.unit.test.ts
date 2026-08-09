import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../../../../shared/telemetry/error-actionability.ts";
import { LegacyDbAdvisorsInvalidTokenError } from "./advisors.errors.ts";

describe("LegacyDbAdvisorsInvalidTokenError actionability", () => {
  const build = (source?: "env" | "stored") =>
    new LegacyDbAdvisorsInvalidTokenError({
      message: "Invalid access token format. Must be like `sbp_0102...1920`.",
      suggestion: "Run supabase login first.",
      source,
    });

  it("classifies an env-provided malformed token as a set-env-var remediation", () => {
    const result = classifyCliErrorActionability(build("env"));
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("auth");
    expect(result.suggestion_type).toBe("set_env_var");
    expect(result.error_fingerprint).toBe("tag:LegacyDbAdvisorsInvalidTokenError");
  });

  it("classifies a stored malformed token as a re-login remediation", () => {
    const result = classifyCliErrorActionability(build("stored"));
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("auth");
    expect(result.suggestion_type).toBe("login");
    expect(result.suggested_command).toBe("supabase login");
  });

  it("defaults to a re-login remediation when the source is unknown", () => {
    const result = classifyCliErrorActionability(build());
    expect(result.suggestion_type).toBe("login");
    expect(result.suggested_command).toBe("supabase login");
  });
});
