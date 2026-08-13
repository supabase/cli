import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../telemetry/error-actionability.ts";
import { FunctionsApiStatusError } from "./functions-api.errors.ts";

describe("FunctionsApiStatusError actionability", () => {
  it("keeps a collection-level 404 on the API-status policy", () => {
    const result = classifyCliErrorActionability(
      new FunctionsApiStatusError({ status: 404, message: "not found" }),
    );
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("api_status");
    expect(result.error_fingerprint).toBe("tag:FunctionsApiStatusError:api_status");
  });

  it("classifies a user-selected function slug 404 as invalid input", () => {
    const result = classifyCliErrorActionability(
      new FunctionsApiStatusError({
        status: 404,
        message: "not found",
        notFoundIsInvalidInput: true,
      }),
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

  it("classifies a successful-status decode failure as an api-response problem", () => {
    const result = classifyCliErrorActionability(
      new FunctionsApiStatusError({
        status: 201,
        message: "failed to read deploy response: unexpected token",
        decode: true,
      }),
    );
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("api_status");
    expect(result.error_fingerprint).toBe("tag:FunctionsApiStatusError:api_response");
  });

  it("classifies a 200 list-functions decode failure as an api-response problem", () => {
    const result = classifyCliErrorActionability(
      new FunctionsApiStatusError({
        status: 200,
        message: "failed to read functions list: unexpected token",
        decode: true,
      }),
    );
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("api_status");
    expect(result.error_fingerprint).toBe("tag:FunctionsApiStatusError:api_response");
  });
});
