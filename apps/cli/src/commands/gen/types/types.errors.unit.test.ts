import { describe, expect, it } from "vitest";
import {
  actionability,
  classifyCliErrorActionability,
} from "../../../shared/telemetry/error-actionability.ts";
import {
  GenTypesBranchCredentialsUnavailableError,
  GenTypesLocalDbInspectError,
  GenTypesLocalDbNotRunningError,
} from "./types.errors.ts";

describe("GenTypesBranchCredentialsUnavailableError actionability", () => {
  it("classifies a branch config without credentials as an API response problem", () => {
    const error = new GenTypesBranchCredentialsUnavailableError({
      message: "Preview branch database credentials are unavailable",
    });

    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe(actionability.apiStatus.error_kind);
    expect(result.error_category).toBe(actionability.apiStatus.error_category);
    expect(result.error_fingerprint).toBe(
      "tag:GenTypesBranchCredentialsUnavailableError:api_response",
    );
  });
});

describe("GenTypesLocalDbNotRunningError actionability", () => {
  it("classifies a missing local DB container as user-actionable with the start-stack remediation", () => {
    const error = new GenTypesLocalDbNotRunningError({ message: "supabase start is not running." });

    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe(actionability.startStack.error_kind);
    expect(result.error_category).toBe(actionability.startStack.error_category);
    expect(result.suggestion_type).toBe(actionability.startStack.suggestion_type);
    expect(result.suggested_command).toBe("supabase start");
    expect(result.error_fingerprint).toBe("tag:GenTypesLocalDbNotRunningError");
  });
});

describe("GenTypesLocalDbInspectError actionability", () => {
  it("classifies an unreachable daemon as docker-not-running", () => {
    const error = new GenTypesLocalDbInspectError({
      message: "failed to inspect service: Cannot connect to the Docker daemon",
      daemonDown: true,
    });

    const result = classifyCliErrorActionability(error);
    expect(result.error_category).toBe("docker_not_running");
    expect(result.error_fingerprint).toBe("tag:GenTypesLocalDbInspectError:docker_not_running");
  });

  it("lands in unknown without suggesting supabase start for any other inspect failure", () => {
    const error = new GenTypesLocalDbInspectError({
      message: "failed to inspect service: unexpected error",
      daemonDown: false,
    });

    const result = classifyCliErrorActionability(error);
    expect(result.error_category).toBe("unknown");
    expect(result.suggested_command).toBeUndefined();
    expect(result.error_fingerprint).toBe("tag:GenTypesLocalDbInspectError");
  });
});
