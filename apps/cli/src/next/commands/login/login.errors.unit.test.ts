import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../../../shared/telemetry/error-actionability.ts";
import { LoginFailedError } from "./login.errors.ts";

const base = { detail: "Login failed after maximum retries", suggestion: "Try again" };

describe("LoginFailedError actionability", () => {
  it("classifies a decoded-body poll failure as an API response problem", () => {
    const result = classifyCliErrorActionability(new LoginFailedError({ ...base, decode: true }));
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("api_status");
    expect(result.error_fingerprint).toBe("tag:LoginFailedError:api_response");
  });

  it("prefers the decode signal over a transport one", () => {
    const result = classifyCliErrorActionability(
      new LoginFailedError({ ...base, network: true, decode: true }),
    );
    expect(result.error_fingerprint).toBe("tag:LoginFailedError:api_response");
  });

  it("classifies a transport failure as network", () => {
    const result = classifyCliErrorActionability(new LoginFailedError({ ...base, network: true }));
    expect(result.error_category).toBe("network");
    expect(result.error_fingerprint).toBe("tag:LoginFailedError:network");
  });

  it("classifies a 5xx poll status as an API status problem", () => {
    const result = classifyCliErrorActionability(
      new LoginFailedError({ ...base, statusCode: 502 }),
    );
    expect(result.error_fingerprint).toBe("tag:LoginFailedError:api_status");
  });

  it("treats an incomplete browser flow (no signal / pending 4xx) as auth login", () => {
    expect(classifyCliErrorActionability(new LoginFailedError(base)).error_category).toBe("auth");
    expect(
      classifyCliErrorActionability(new LoginFailedError({ ...base, statusCode: 400 }))
        .error_category,
    ).toBe("auth");
  });
});
