import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../../../../shared/telemetry/error-actionability.ts";
import { LegacyFunctionsListUnexpectedStatusError } from "./list.errors.ts";

describe("LegacyFunctionsListUnexpectedStatusError actionability", () => {
  it("keeps collection-level 404s on the API-status policy", () => {
    expect(
      classifyCliErrorActionability(
        new LegacyFunctionsListUnexpectedStatusError({
          status: 404,
          body: "not found",
          message: "unexpected list functions status 404: not found",
        }),
      ),
    ).toMatchObject({
      error_kind: "external_service",
      error_category: "api_status",
      error_fingerprint: "tag:LegacyFunctionsListUnexpectedStatusError:api_status",
    });
  });
});
