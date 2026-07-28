import { describe, expect, it } from "vitest";

import { legacyParseSnippetUuid } from "./download.handler.ts";

describe("legacyParseSnippetUuid", () => {
  it("accepts the canonical 36-char hyphenated form, lowercasing uppercase hex", () => {
    expect(legacyParseSnippetUuid("0b0d48f6-878b-4190-88d7-2ca33ed800bc")).toEqual({
      canonical: "0b0d48f6-878b-4190-88d7-2ca33ed800bc",
    });
    expect(legacyParseSnippetUuid("0B0D48F6-878B-4190-88D7-2CA33ED800BC")).toEqual({
      canonical: "0b0d48f6-878b-4190-88d7-2ca33ed800bc",
    });
  });

  it("accepts the raw 32-hex form and returns the canonical hyphenated lowercase form", () => {
    expect(legacyParseSnippetUuid("0b0d48f6878b419088d72ca33ed800bc")).toEqual({
      canonical: "0b0d48f6-878b-4190-88d7-2ca33ed800bc",
    });
    expect(legacyParseSnippetUuid("0B0D48F6878B419088D72CA33ED800BC")).toEqual({
      canonical: "0b0d48f6-878b-4190-88d7-2ca33ed800bc",
    });
  });

  it("accepts a urn:uuid: prefix, case-insensitively", () => {
    expect(legacyParseSnippetUuid("urn:uuid:0b0d48f6-878b-4190-88d7-2ca33ed800bc")).toEqual({
      canonical: "0b0d48f6-878b-4190-88d7-2ca33ed800bc",
    });
    expect(legacyParseSnippetUuid("URN:UUID:0b0d48f6-878b-4190-88d7-2ca33ed800bc")).toEqual({
      canonical: "0b0d48f6-878b-4190-88d7-2ca33ed800bc",
    });
  });

  it("accepts the braced form, never validating the trailing 38th char (s = s[1:] quirk)", () => {
    expect(legacyParseSnippetUuid("{0b0d48f6-878b-4190-88d7-2ca33ed800bc}")).toEqual({
      canonical: "0b0d48f6-878b-4190-88d7-2ca33ed800bc",
    });
    // The 38th (trailing) character is `!`, not `}` — still parses, because Go's
    // `s = s[1:]` only strips the leading brace and never inspects the last byte.
    expect(legacyParseSnippetUuid("{0b0d48f6-878b-4190-88d7-2ca33ed800bc!")).toEqual({
      canonical: "0b0d48f6-878b-4190-88d7-2ca33ed800bc",
    });
  });

  it("rejects the wrong length with `invalid UUID length: <n>`", () => {
    expect(legacyParseSnippetUuid("not-a-uuid")).toEqual({
      error: "invalid UUID length: 10",
    });
    expect(legacyParseSnippetUuid("")).toEqual({
      error: "invalid UUID length: 0",
    });
  });

  it('rejects 45 chars with a bad prefix with `invalid urn prefix: "<first 9 chars>"`', () => {
    expect(legacyParseSnippetUuid("xrn:uuid:0b0d48f6-878b-4190-88d7-2ca33ed800bc")).toEqual({
      error: 'invalid urn prefix: "xrn:uuid:"',
    });
  });

  it("rejects 36 chars with misplaced hyphens or non-hex with `invalid UUID format`", () => {
    // Dots instead of hyphens at the canonical dash positions.
    expect(legacyParseSnippetUuid("0b0d48f6.878b.4190.88d7.2ca33ed800bc")).toEqual({
      error: "invalid UUID format",
    });
    // Correct dash positions, but a non-hex character in the payload.
    expect(legacyParseSnippetUuid("0b0d48f6-878b-4190-88d7-2ca33ed800bg")).toEqual({
      error: "invalid UUID format",
    });
  });

  it("rejects 32 non-hex chars with `invalid UUID format`", () => {
    expect(legacyParseSnippetUuid("0b0d48f6878b419088d72ca33ed800bg")).toEqual({
      error: "invalid UUID format",
    });
  });
});
