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

  // Go's `uuid.Parse` dispatches on `len(s)` — UTF-8 BYTES — where a JS
  // string's `length` counts UTF-16 code units. Non-ASCII arguments must take
  // Go's branch and report Go's byte count. Every expectation below is ground
  // truth from go1.26 + google/uuid v1.6.0.
  describe("UTF-8 byte-length dispatch (non-ASCII arguments)", () => {
    const canonical = "0b0d48f6-878b-4190-88d7-2ca33ed800bc";

    it("counts a multibyte char as its byte width, never slipping into the braced branch", () => {
      // JS length 38 (would hit the braced branch and issue a request for the
      // embedded canonical UUID); Go sees 39 bytes → length error.
      expect(legacyParseSnippetUuid(`é${canonical}}`)).toEqual({
        error: "invalid UUID length: 39",
      });
      expect(legacyParseSnippetUuid(`{${canonical}é`)).toEqual({
        error: "invalid UUID length: 39",
      });
      // JS length 36; Go sees 37 bytes.
      expect(legacyParseSnippetUuid(`é${canonical.slice(1)}`)).toEqual({
        error: "invalid UUID length: 37",
      });
    });

    it("slices the urn prefix by byte and %q-quotes it (printable rune prints literally)", () => {
      // 2 (é) + 7 + 36 = 45 bytes → urn branch; first 9 BYTES are "érn:uuid".
      expect(legacyParseSnippetUuid(`érn:uuid${canonical}`)).toEqual({
        error: 'invalid urn prefix: "érn:uuid"',
      });
    });

    it("renders a rune split by the 9-byte prefix slice as Go's lone \\xNN escape", () => {
      // 8 ASCII + é(2 bytes) + 35 = 45 bytes; byte 9 cuts é in half, so Go's
      // `%q` shows its orphaned lead byte: `"12345678\xc3"`.
      expect(legacyParseSnippetUuid(`12345678é${canonical.slice(0, 35)}`)).toEqual({
        error: 'invalid urn prefix: "12345678\\xc3"',
      });
    });
  });
});
