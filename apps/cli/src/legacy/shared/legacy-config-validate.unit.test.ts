import { describe, expect, it } from "vitest";

import {
  LEGACY_BUCKET_NAME_PATTERN,
  LEGACY_CLERK_DOMAIN_PATTERN,
  LEGACY_FUNCTION_SLUG_PATTERN,
  LEGACY_HOOK_SECRET_PATTERN,
  LEGACY_PROJECT_REF_PATTERN,
  legacyParseGoBool,
} from "./legacy-config-validate.ts";

// Starter suite for the symbols relocated from `legacy-db-config.toml-read.ts` in this
// commit. The bulk of `Config.Validate` behavioral coverage (the eventual
// `legacyValidateResolvedConfig` entry point) moves here in a later commit — see the
// module header in `legacy-config-validate.ts`.

describe("legacyParseGoBool", () => {
  it("accepts Go's strconv.ParseBool true forms", () => {
    for (const value of ["1", "t", "T", "TRUE", "true", "True"]) {
      expect(legacyParseGoBool(value)).toBe(true);
    }
  });

  it("accepts Go's strconv.ParseBool false forms, including the empty string", () => {
    for (const value of ["0", "f", "F", "FALSE", "false", "False", ""]) {
      expect(legacyParseGoBool(value)).toBe(false);
    }
  });

  it("returns undefined for a value outside Go's strconv.ParseBool acceptance set", () => {
    expect(legacyParseGoBool("yes")).toBeUndefined();
    expect(legacyParseGoBool("2")).toBeUndefined();
  });
});

describe("LEGACY_PROJECT_REF_PATTERN", () => {
  it("matches a valid 20-character lowercase project ref", () => {
    expect(LEGACY_PROJECT_REF_PATTERN.test("abcdefghijklmnopqrst")).toBe(true);
  });

  it("rejects refs of the wrong length or case", () => {
    expect(LEGACY_PROJECT_REF_PATTERN.test("short")).toBe(false);
    expect(LEGACY_PROJECT_REF_PATTERN.test("ABCDEFGHIJKLMNOPQRST")).toBe(false);
  });
});

describe("LEGACY_BUCKET_NAME_PATTERN", () => {
  it("matches Go-legal bucket name characters", () => {
    expect(LEGACY_BUCKET_NAME_PATTERN.test("my-bucket.1")).toBe(true);
  });

  it("rejects characters outside Go's bucketNamePattern", () => {
    expect(LEGACY_BUCKET_NAME_PATTERN.test("bad#name")).toBe(false);
    expect(LEGACY_BUCKET_NAME_PATTERN.test("bad/name")).toBe(false);
  });
});

describe("LEGACY_FUNCTION_SLUG_PATTERN", () => {
  it("matches a valid function slug (letters, digits, _ and -)", () => {
    expect(LEGACY_FUNCTION_SLUG_PATTERN.test("my-function")).toBe(true);
    expect(LEGACY_FUNCTION_SLUG_PATTERN.test("function_1")).toBe(true);
  });

  it("rejects a slug that doesn't start with a letter", () => {
    expect(LEGACY_FUNCTION_SLUG_PATTERN.test("123")).toBe(false);
    expect(LEGACY_FUNCTION_SLUG_PATTERN.test("1bad")).toBe(false);
  });
});

describe("LEGACY_HOOK_SECRET_PATTERN", () => {
  it("matches a valid v1,whsec_ secret", () => {
    expect(LEGACY_HOOK_SECRET_PATTERN.test(`v1,whsec_${"a".repeat(32)}`)).toBe(true);
  });

  it("rejects a secret that doesn't match Go's hookSecretPattern", () => {
    expect(LEGACY_HOOK_SECRET_PATTERN.test("not-a-valid-secret")).toBe(false);
  });
});

describe("LEGACY_CLERK_DOMAIN_PATTERN", () => {
  it("matches a valid clerk.example.com domain", () => {
    expect(LEGACY_CLERK_DOMAIN_PATTERN.test("clerk.example.com")).toBe(true);
  });

  it("matches a valid <slug>.clerk.accounts.dev domain", () => {
    expect(LEGACY_CLERK_DOMAIN_PATTERN.test("example.clerk.accounts.dev")).toBe(true);
  });

  it("rejects a domain that doesn't match Go's clerkDomainPattern", () => {
    expect(LEGACY_CLERK_DOMAIN_PATTERN.test("not-a-clerk-domain")).toBe(false);
  });
});
