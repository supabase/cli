import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../../../shared/telemetry/error-actionability.ts";
import {
  LegacyLinkAuthTokenError,
  LegacyLinkBranchListNetworkError,
  LegacyLinkBranchListStatusError,
  LegacyLinkBranchNotReadyError,
  LegacyLinkMissingKeyError,
  LegacyLinkParentRefInvalidError,
  LegacyLinkProjectStatusError,
  LegacyLinkProjectStatusNetworkError,
} from "./link.errors.ts";

describe("LegacyLinkProjectStatusNetworkError actionability", () => {
  it("classifies a body-decode failure as an API response problem", () => {
    const result = classifyCliErrorActionability(
      new LegacyLinkProjectStatusNetworkError({ message: "boom", decode: true }),
    );
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("api_status");
    expect(result.error_fingerprint).toBe("tag:LegacyLinkProjectStatusNetworkError:api_response");
  });

  it("classifies a transport failure as network", () => {
    const result = classifyCliErrorActionability(
      new LegacyLinkProjectStatusNetworkError({ message: "boom" }),
    );
    expect(result.error_category).toBe("network");
  });
});

describe("link response actionability", () => {
  it("classifies a missing selected project from the api-keys request as invalid input", () => {
    const result = classifyCliErrorActionability(
      new LegacyLinkAuthTokenError({ status: 404, body: "ignored", message: "ignored" }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("invalid_input");
    expect(result.error_fingerprint).toBe("tag:LegacyLinkAuthTokenError:not_found");
  });

  it("keeps the project-status fallback 404 on the API-status policy", () => {
    const result = classifyCliErrorActionability(
      new LegacyLinkProjectStatusError({ status: 404, body: "ignored", message: "ignored" }),
    );
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("api_status");
    expect(result.error_fingerprint).toBe("tag:LegacyLinkProjectStatusError:api_status");
  });

  it("classifies a successful api-keys response missing both keys as an API response failure", () => {
    const result = classifyCliErrorActionability(
      new LegacyLinkMissingKeyError({ message: "Anon key not found." }),
    );
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("api_status");
    expect(result.error_fingerprint).toBe("tag:LegacyLinkMissingKeyError:api_response");
  });
});

describe("branch-name resolution actionability (CLI-2167)", () => {
  it("classifies a branch-list 404 as invalid input, same policy as the api-keys 404", () => {
    const result = classifyCliErrorActionability(
      new LegacyLinkBranchListStatusError({ status: 404, body: "ignored", message: "ignored" }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("invalid_input");
    expect(result.error_fingerprint).toBe("tag:LegacyLinkBranchListStatusError:not_found");
  });

  it("keeps a non-404 branch-list status on the API-status policy", () => {
    const result = classifyCliErrorActionability(
      new LegacyLinkBranchListStatusError({ status: 500, body: "ignored", message: "ignored" }),
    );
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("api_status");
    expect(result.error_fingerprint).toBe("tag:LegacyLinkBranchListStatusError:api_status");
  });

  it("classifies a branch-list body-decode failure as an API response problem", () => {
    const result = classifyCliErrorActionability(
      new LegacyLinkBranchListNetworkError({ message: "boom", decode: true }),
    );
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("api_status");
    expect(result.error_fingerprint).toBe("tag:LegacyLinkBranchListNetworkError:api_response");
  });

  it("classifies a branch-list transport failure as network", () => {
    const result = classifyCliErrorActionability(
      new LegacyLinkBranchListNetworkError({ message: "boom" }),
    );
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("network");
  });

  it("classifies an invalid linked parent ref as a relink-project remediation", () => {
    const result = classifyCliErrorActionability(
      new LegacyLinkParentRefInvalidError({ message: "ignored" }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("invalid_config");
    expect(result.suggestion_type).toBe("link_project");
    expect(result.suggested_command).toBe("supabase link");
  });

  it("classifies a not-yet-provisioned branch as an API-status problem with its own fingerprint", () => {
    const result = classifyCliErrorActionability(
      new LegacyLinkBranchNotReadyError({
        branch: "feature-branch",
        status: "CREATING_PROJECT",
        message: "ignored",
      }),
    );
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("api_status");
    expect(result.error_fingerprint).toBe("tag:LegacyLinkBranchNotReadyError:branch_not_ready");
  });
});
