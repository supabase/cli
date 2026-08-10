import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../telemetry/error-actionability.ts";
import { UnsafeFunctionDownloadPathError } from "./download.errors.ts";

describe("UnsafeFunctionDownloadPathError actionability", () => {
  it("classifies a response-derived unsafe path as an API response problem", () => {
    const result = classifyCliErrorActionability(
      new UnsafeFunctionDownloadPathError({
        message: "refusing to extract Function file outside supabase/functions: ../evil",
        unsafeResponsePath: true,
      }),
    );
    expect(result.error_kind).toBe("external_service");
    expect(result.error_category).toBe("api_status");
    expect(result.error_fingerprint).toBe("tag:UnsafeFunctionDownloadPathError:api_response");
  });

  it("keeps a local temp-file write/rename failure on the permission policy", () => {
    const result = classifyCliErrorActionability(
      new UnsafeFunctionDownloadPathError({
        message: "failed to write Function file: index.ts: EACCES",
      }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("permission");
    expect(result.error_fingerprint).toBe("tag:UnsafeFunctionDownloadPathError");
  });

  it("keeps an explicitly-false unsafeResponsePath on the permission policy", () => {
    const result = classifyCliErrorActionability(
      new UnsafeFunctionDownloadPathError({
        message: "failed to create temporary Function file while extracting index.ts: EACCES",
        unsafeResponsePath: false,
      }),
    );
    expect(result.error_category).toBe("permission");
  });
});
