import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../../../shared/telemetry/error-actionability.ts";
import {
  LegacySsoAddAttributeMappingFileError,
  LegacySsoAddMetadataFileError,
  LegacySsoMetadataUrlNetworkError,
  LegacySsoUpdateAttributeMappingFileError,
  LegacySsoUpdateMetadataFileError,
} from "./sso.errors.ts";
import type { LegacySsoFileErrorReason } from "./sso.saml.ts";

describe("LegacySsoMetadataUrlNetworkError actionability", () => {
  it("classifies a failed user-supplied --metadata-url as a flag input problem", () => {
    const result = classifyCliErrorActionability(
      new LegacySsoMetadataUrlNetworkError({ message: "failed to fetch metadata url: timeout" }),
    );
    expect(result.error_kind).toBe("user_actionable");
    expect(result.error_category).toBe("invalid_input");
    expect(result.suggestion_type).toBe("provide_flags");
  });
});

describe("SSO file error actionability", () => {
  const factories: ReadonlyArray<(reason: LegacySsoFileErrorReason) => Error> = [
    (reason) => new LegacySsoAddMetadataFileError({ message: "file error", reason }),
    (reason) => new LegacySsoAddAttributeMappingFileError({ message: "file error", reason }),
    (reason) => new LegacySsoUpdateMetadataFileError({ message: "file error", reason }),
    (reason) => new LegacySsoUpdateAttributeMappingFileError({ message: "file error", reason }),
  ];

  it("distinguishes missing, unreadable, invalid, URL, and ambiguous failures", () => {
    for (const makeError of factories) {
      expect(classifyCliErrorActionability(makeError("not_found"))).toMatchObject({
        error_category: "invalid_input",
        suggestion_type: "provide_flags",
        error_fingerprint: expect.stringContaining(":not_found"),
      });
      expect(classifyCliErrorActionability(makeError("permission"))).toMatchObject({
        error_category: "permission",
        suggestion_type: "none",
        error_fingerprint: expect.stringContaining(":filesystem"),
      });
      expect(classifyCliErrorActionability(makeError("invalid_content"))).toMatchObject({
        error_category: "invalid_input",
        suggestion_type: "none",
        error_fingerprint: expect.stringContaining(":invalid_content"),
      });
      expect(classifyCliErrorActionability(makeError("invalid_url"))).toMatchObject({
        error_category: "invalid_input",
        suggestion_type: "provide_flags",
        error_fingerprint: expect.stringContaining(":invalid_url"),
      });
      expect(classifyCliErrorActionability(makeError("other"))).toMatchObject({
        error_kind: "unknown",
        error_category: "unknown",
        suggestion_type: "none",
        error_fingerprint: expect.stringContaining(":platform_error"),
      });
    }
  });
});
