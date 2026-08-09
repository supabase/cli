import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../../../shared/telemetry/error-actionability.ts";
import {
  LegacyBranchesCreateUnexpectedStatusError,
  LegacyBranchesDeleteUnexpectedStatusError,
  LegacyBranchesPauseUnexpectedStatusError,
  LegacyBranchesUnpauseUnexpectedStatusError,
  LegacyBranchesUpdateUnexpectedStatusError,
} from "./branches.errors.ts";

const body = { body: "not found", message: "boom" };

describe("branch operation 404s classify as invalid input", () => {
  it("pause 404 → invalid input", () => {
    const result = classifyCliErrorActionability(
      new LegacyBranchesPauseUnexpectedStatusError({ status: 404, ...body }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("invalid_input");
    expect(result.error_fingerprint).toBe("tag:LegacyBranchesPauseUnexpectedStatusError:not_found");
  });

  it("unpause 404 → invalid input", () => {
    const result = classifyCliErrorActionability(
      new LegacyBranchesUnpauseUnexpectedStatusError({ status: 404, ...body }),
    );
    expect(result.error_category).toBe("invalid_input");
    expect(result.error_fingerprint).toBe(
      "tag:LegacyBranchesUnpauseUnexpectedStatusError:not_found",
    );
  });

  it("delete 404 → invalid input", () => {
    const result = classifyCliErrorActionability(
      new LegacyBranchesDeleteUnexpectedStatusError({ status: 404, ...body }),
    );
    expect(result.error_category).toBe("invalid_input");
    expect(result.error_fingerprint).toBe(
      "tag:LegacyBranchesDeleteUnexpectedStatusError:not_found",
    );
  });

  it("a non-404 status stays on the status policy", () => {
    const result = classifyCliErrorActionability(
      new LegacyBranchesPauseUnexpectedStatusError({ status: 500, ...body }),
    );
    expect(result.error_category).toBe("api_status");
  });
});

describe("gated branch operation 404s", () => {
  it("update 404 without an upgrade gate → invalid input", () => {
    const result = classifyCliErrorActionability(
      new LegacyBranchesUpdateUnexpectedStatusError({ status: 404, ...body }),
    );
    expect(result.error_category).toBe("invalid_input");
    expect(result.suggestion_type).toBe("none");
  });

  it("create 404 without an upgrade gate → invalid input", () => {
    const result = classifyCliErrorActionability(
      new LegacyBranchesCreateUnexpectedStatusError({ status: 404, ...body }),
    );
    expect(result.error_category).toBe("invalid_input");
    expect(result.suggestion_type).toBe("none");
  });

  it("update: a confirmed plan gate is not shadowed by the 404 branch", () => {
    const result = classifyCliErrorActionability(
      new LegacyBranchesUpdateUnexpectedStatusError({
        status: 404,
        ...body,
        upgradeSuggested: true,
      }),
    );
    expect(result.error_category).toBe("plan_limit");
    expect(result.suggestion_type).toBe("upgrade_plan");
  });

  it("create: a confirmed plan gate is not shadowed by the 404 branch", () => {
    const result = classifyCliErrorActionability(
      new LegacyBranchesCreateUnexpectedStatusError({
        status: 404,
        ...body,
        upgradeSuggested: true,
      }),
    );
    expect(result.error_category).toBe("plan_limit");
    expect(result.suggestion_type).toBe("upgrade_plan");
  });
});

describe("branches create 409 = duplicate branch name", () => {
  it("create 409 without an upgrade gate → invalid input (conflict)", () => {
    const result = classifyCliErrorActionability(
      new LegacyBranchesCreateUnexpectedStatusError({ status: 409, ...body }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("invalid_input");
    expect(result.error_fingerprint).toBe("tag:LegacyBranchesCreateUnexpectedStatusError:conflict");
  });

  it("create: a confirmed plan gate is not shadowed by the 409 branch", () => {
    const result = classifyCliErrorActionability(
      new LegacyBranchesCreateUnexpectedStatusError({
        status: 409,
        ...body,
        upgradeSuggested: true,
      }),
    );
    expect(result.error_category).toBe("plan_limit");
    expect(result.suggestion_type).toBe("upgrade_plan");
  });
});
