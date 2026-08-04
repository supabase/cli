import { Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  legacyBuildBearerJwtClaims,
  legacyEncodeBearerJwtClaims,
  legacyMergeBearerJwtPayload,
} from "./bearer-jwt.claims.ts";

const NOW = 1_700_000_000;

describe("legacyBuildBearerJwtClaims", () => {
  it("always includes role, even an empty string, with no omitempty", () => {
    const claims = legacyBuildBearerJwtClaims({
      role: "",
      sub: Option.none(),
      expiresAt: Option.none(),
      validForSeconds: 1800,
      nowSeconds: NOW,
    });
    expect(claims["role"]).toBe("");
  });

  it("computes iat = now and exp = now + validFor when --exp is not given", () => {
    const claims = legacyBuildBearerJwtClaims({
      role: "anon",
      sub: Option.none(),
      expiresAt: Option.none(),
      validForSeconds: 1800,
      nowSeconds: NOW,
    });
    expect(claims["iat"]).toBe(NOW);
    expect(claims["exp"]).toBe(NOW + 1800);
  });

  it("computes exp = --exp and iat = exp - validFor when --exp is given", () => {
    const claims = legacyBuildBearerJwtClaims({
      role: "anon",
      sub: Option.none(),
      expiresAt: Option.some(2_000_000_000),
      validForSeconds: 1800,
      nowSeconds: NOW,
    });
    expect(claims["exp"]).toBe(2_000_000_000);
    expect(claims["iat"]).toBe(2_000_000_000 - 1800);
  });

  it("floors only the FINAL iat, applying a sub-second --valid-for before truncating (CLI-1961)", () => {
    // Verified against the real binary: `--exp 2030-01-01T00:00:00Z --valid-for 1.5s`
    // yields Go `iat=1893455998` — flooring the 1.5s duration to 1s BEFORE subtracting
    // (this port's previous behavior) would wrongly yield 1893455999.
    const claims = legacyBuildBearerJwtClaims({
      role: "anon",
      sub: Option.none(),
      expiresAt: Option.some(1_893_456_000),
      validForSeconds: 1.5,
      nowSeconds: NOW,
    });
    expect(claims["exp"]).toBe(1_893_456_000);
    expect(claims["iat"]).toBe(1_893_455_998);
  });

  it("sets is_anonymous when --sub is explicitly passed as an empty string (CLI-1961)", () => {
    // Go's gate is `len(claims.Subject) == 0` (`cmd/gen.go:195`) — an explicitly-passed
    // EMPTY `--sub ""` still counts as "no subject", not just an omitted flag.
    const claims = legacyBuildBearerJwtClaims({
      role: "authenticated",
      sub: Option.some(""),
      expiresAt: Option.none(),
      validForSeconds: 1800,
      nowSeconds: NOW,
    });
    expect(claims["is_anonymous"]).toBe(true);
    expect("sub" in claims).toBe(false);
  });

  it("sets is_anonymous when role is 'authenticated' (case-insensitive) and sub is absent", () => {
    const claims = legacyBuildBearerJwtClaims({
      role: "AUTHENTICATED",
      sub: Option.none(),
      expiresAt: Option.none(),
      validForSeconds: 1800,
      nowSeconds: NOW,
    });
    expect(claims["is_anonymous"]).toBe(true);
    // Role keeps its original casing.
    expect(claims["role"]).toBe("AUTHENTICATED");
  });

  it("does not set is_anonymous when role is authenticated but sub is given", () => {
    const claims = legacyBuildBearerJwtClaims({
      role: "authenticated",
      sub: Option.some("user-1"),
      expiresAt: Option.none(),
      validForSeconds: 1800,
      nowSeconds: NOW,
    });
    expect(claims["is_anonymous"]).toBeUndefined();
    expect(claims["sub"]).toBe("user-1");
  });

  it("does not set is_anonymous for a non-authenticated role", () => {
    const claims = legacyBuildBearerJwtClaims({
      role: "postgres",
      sub: Option.none(),
      expiresAt: Option.none(),
      validForSeconds: 1800,
      nowSeconds: NOW,
    });
    expect(claims["is_anonymous"]).toBeUndefined();
  });

  it("omits sub entirely when not given (omitempty)", () => {
    const claims = legacyBuildBearerJwtClaims({
      role: "service_role",
      sub: Option.none(),
      expiresAt: Option.none(),
      validForSeconds: 1800,
      nowSeconds: NOW,
    });
    expect("sub" in claims).toBe(false);
  });
});

describe("legacyMergeBearerJwtPayload", () => {
  it("is a no-op for the default '{}' payload", () => {
    const claims = { role: "anon" };
    expect(legacyMergeBearerJwtPayload(claims, "{}")).toEqual({ role: "anon" });
  });

  it("merges payload keys on top of (overriding) existing claims", () => {
    const claims = { role: "postgres", exp: 1, iat: 2 };
    const merged = legacyMergeBearerJwtPayload(
      claims,
      '{"role":"override","sb-role":"mgmt-api","aud":"x"}',
    );
    expect(merged).toEqual({
      role: "override",
      exp: 1,
      iat: 2,
      "sb-role": "mgmt-api",
      aud: "x",
    });
  });

  it("treats a JSON null payload as a no-op", () => {
    const claims = { role: "anon" };
    expect(legacyMergeBearerJwtPayload(claims, "null")).toEqual({ role: "anon" });
  });

  it("rejects an array payload with Go's unmarshal-type-mismatch message", () => {
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, "[]")).toThrow(
      "json: cannot unmarshal array into Go value of type jwt.MapClaims",
    );
  });

  it("rejects a scalar number payload with Go's unmarshal-type-mismatch message", () => {
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, "123")).toThrow(
      "json: cannot unmarshal number into Go value of type jwt.MapClaims",
    );
  });

  it("rejects a scalar string payload with Go's unmarshal-type-mismatch message", () => {
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, '"str"')).toThrow(
      "json: cannot unmarshal string into Go value of type jwt.MapClaims",
    );
  });

  it("rejects a scalar boolean payload with Go's unmarshal-type-mismatch message", () => {
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, "true")).toThrow(
      "json: cannot unmarshal bool into Go value of type jwt.MapClaims",
    );
  });

  it("rejects an empty payload with Go's exact 'unexpected end of JSON input'", () => {
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, "")).toThrow(
      "unexpected end of JSON input",
    );
  });

  it("rejects trailing garbage after a valid value with Go's exact 'after top-level value' text", () => {
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, "{}{}")).toThrow(
      "invalid character '{' after top-level value",
    );
  });

  it("accepts a payload value of null for an individual key (distinct from a null top-level payload)", () => {
    const merged = legacyMergeBearerJwtPayload({ role: "anon", sub: "x" }, '{"sub":null}');
    expect(merged["sub"]).toBeNull();
  });

  it("reports a partial keyword match against Go's exact 'in literal' wording", () => {
    // `not-json-at-all` starts with `n`, which Go's scanner reads as the start of the
    // `null` literal; the second byte `o` mismatches `null`'s `u` — Go's own scanner
    // text for this is `invalid character 'o' in literal null (expecting 'u')`.
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, "not-json-at-all")).toThrow(
      "invalid character 'o' in literal null (expecting 'u')",
    );
  });

  it("rejects a truncated object with Go's exact 'unexpected end of JSON input'", () => {
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, '{"a":1')).toThrow(
      "unexpected end of JSON input",
    );
  });

  it("rejects a truncated array with Go's exact 'unexpected end of JSON input'", () => {
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, "[1,2")).toThrow(
      "unexpected end of JSON input",
    );
  });

  it("rejects an object truncated inside a nested unterminated string", () => {
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, '{"a')).toThrow(
      "unexpected end of JSON input",
    );
  });

  it("reports trailing garbage after a validly nested container, not on the inner close", () => {
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, "{[]}x")).toThrow(
      "invalid character 'x' after top-level value",
    );
  });

  it("rejects an unterminated string with Go's exact 'unexpected end of JSON input'", () => {
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, '"unterminated')).toThrow(
      "unexpected end of JSON input",
    );
  });

  it("reports trailing garbage after a valid string value", () => {
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, '"abc"def')).toThrow(
      "invalid character 'd' after top-level value",
    );
  });

  it("skips over an escaped quote inside a string when finding where it closes", () => {
    // The actual payload bytes are: `"` `a` `\` `"` `b` `"` `c` — a string containing an
    // escaped quote (`a"b`), followed by trailing garbage `c`.
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, '"a\\"b"c')).toThrow(
      "invalid character 'c' after top-level value",
    );
  });

  it("rejects a truncated literal (a strict prefix of a keyword) as truncated, not a mismatch", () => {
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, "tru")).toThrow(
      "unexpected end of JSON input",
    );
  });

  it("reports trailing garbage after a FULLY matched literal keyword", () => {
    // "null" matches completely; JSC's own tokenizer reports this generically (no
    // position), unlike a partial mismatch — this exercises that specific fall-through.
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, "nullx")).toThrow(
      "invalid character 'x' after top-level value",
    );
  });

  it("rejects a lone digit-less minus sign with Go's exact 'unexpected end of JSON input'", () => {
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, "-")).toThrow(
      "unexpected end of JSON input",
    );
  });

  it("reports trailing garbage after a valid number value", () => {
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, "123abc")).toThrow(
      "invalid character 'a' after top-level value",
    );
  });

  it("reports the actual first invalid character for a byte that can never start a value", () => {
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, "@")).toThrow(
      "invalid character '@' looking for beginning of value",
    );
  });

  it("falls back to the generic message when the only valid prefix is the WHOLE trimmed string", () => {
    // A leading vertical tab is in JS's `\s` regex class (so `trimmed` strips it) but is
    // NOT valid JSON whitespace (so the original `JSON.parse(payload)` call still fails
    // on it) — `trimmed` alone ("{}") is then a single complete, valid JSON value with
    // nothing left over, which must fall through to the generic message rather than
    // reporting on empty leftover content. Built via `String.fromCharCode` rather than a
    // literal escape so no raw control byte sits in the source file.
    const verticalTab = String.fromCharCode(11);
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, `${verticalTab}{}`)).toThrow(
      "invalid character looking for beginning of value",
    );
  });
});

describe("legacyEncodeBearerJwtClaims", () => {
  it("serializes claims with alphabetically sorted keys, matching Go's jwt.MapClaims", () => {
    const claims = { role: "authenticated", is_anonymous: true, exp: 200, iat: 100 };
    expect(legacyEncodeBearerJwtClaims(claims)).toBe(
      '{"exp":200,"iat":100,"is_anonymous":true,"role":"authenticated"}',
    );
  });

  it("HTML-escapes special characters like Go's default json.Marshal", () => {
    const claims = { role: "a<b>&c" };
    expect(legacyEncodeBearerJwtClaims(claims)).toBe('{"role":"a\\u003cb\\u003e\\u0026c"}');
  });

  it("sorts nested object keys recursively too", () => {
    const claims = { role: "anon", custom: { z: 1, a: 2 } };
    expect(legacyEncodeBearerJwtClaims(claims)).toBe('{"custom":{"a":2,"z":1},"role":"anon"}');
  });
});
