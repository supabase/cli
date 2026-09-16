import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../../shared/telemetry/error-actionability.ts";
import { LoginFailedError, LoginSaveTokenError } from "./login.errors.ts";

describe("LoginFailedError actionability", () => {
  it("classifies a decoded-body poll failure as an API response problem", () => {
    const result = classifyCliErrorActionability(
      new LoginFailedError({ message: "boom", decode: true }),
    );
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("api_status");
    expect(result.error_fingerprint).toBe("tag:LoginFailedError:api_response");
  });

  it("prefers the decode signal over a transport one", () => {
    const result = classifyCliErrorActionability(
      new LoginFailedError({ message: "boom", network: true, decode: true }),
    );
    expect(result.error_fingerprint).toBe("tag:LoginFailedError:api_response");
  });

  it("classifies a transport failure as network", () => {
    const result = classifyCliErrorActionability(
      new LoginFailedError({ message: "boom", network: true }),
    );
    expect(result.error_category).toBe("network");
    expect(result.error_fingerprint).toBe("tag:LoginFailedError:network");
  });

  it("classifies a 5xx poll status as an API status problem", () => {
    const result = classifyCliErrorActionability(
      new LoginFailedError({ message: "boom", statusCode: 503 }),
    );
    expect(result.error_fingerprint).toBe("tag:LoginFailedError:api_status");
  });

  it("treats an incomplete browser flow (no signal / pending 4xx) as auth login", () => {
    expect(
      classifyCliErrorActionability(new LoginFailedError({ message: "boom" })).error_category,
    ).toBe("auth");
    expect(
      classifyCliErrorActionability(new LoginFailedError({ message: "boom", statusCode: 400 }))
        .error_category,
    ).toBe("auth");
  });
});

describe("LoginSaveTokenError actionability", () => {
  it("classifies a provided-token save failure as a token problem", () => {
    const result = classifyCliErrorActionability(
      new LoginSaveTokenError({ message: "cannot save provided token: bad" }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("auth");
    expect(result.suggestion_type).toBe("set_env_var");
  });
});
