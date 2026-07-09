import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../../../shared/telemetry/error-actionability.ts";
import { LegacyLinkProjectStatusNetworkError } from "./link.errors.ts";

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
