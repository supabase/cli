import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../telemetry/error-actionability.ts";
import { FunctionsApiStatusError } from "./functions-api.errors.ts";

describe("FunctionsApiStatusError actionability", () => {
  it("classifies a 404 (unknown project ref / function slug) as invalid input", () => {
    const result = classifyCliErrorActionability(
      new FunctionsApiStatusError({ status: 404, message: "not found" }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("invalid_input");
    expect(result.error_fingerprint).toBe("tag:FunctionsApiStatusError:not_found");
  });

  it("keeps a 401 on the auth-login policy", () => {
    const result = classifyCliErrorActionability(
      new FunctionsApiStatusError({ status: 401, message: "unauthorized" }),
    );
    expect(result.error_category).toBe("auth");
  });

  it("keeps a 5xx on the API status policy", () => {
    const result = classifyCliErrorActionability(
      new FunctionsApiStatusError({ status: 500, message: "server error" }),
    );
    expect(result.error_category).toBe("api_status");
  });
});
