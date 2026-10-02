import { Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  buildBearerJwtClaims,
  encodeBearerJwtClaims,
  mergeBearerJwtPayload,
} from "./bearer-jwt.claims.ts";

const NOW = 1_700_000_000;
const NOW_INSTANT = { wholeSeconds: NOW, nanos: 0 };

describe("buildBearerJwtClaims", () => {
  it("always includes role, even an empty string, with no omitempty", () => {
    const claims = buildBearerJwtClaims({
      role: "",
      sub: Option.none(),
      expiresAt: Option.none(),
      validForSeconds: 1800,
      nowInstant: NOW_INSTANT,
    });
    expect(claims["role"]).toBe("");
  });

  it("computes iat = now and exp = now + validFor when --exp is not given", () => {
    const claims = buildBearerJwtClaims({
      role: "anon",
      sub: Option.none(),
      expiresAt: Option.none(),
      validForSeconds: 1800,
      nowInstant: NOW_INSTANT,
    });
    expect(claims["iat"]).toBe(NOW);
    expect(claims["exp"]).toBe(NOW + 1800);
  });

  it("computes exp = --exp and iat = exp - validFor when --exp is given", () => {
    const claims = buildBearerJwtClaims({
      role: "anon",
      sub: Option.none(),
      expiresAt: Option.some({ wholeSeconds: 2_000_000_000, nanos: 0 }),
      validForSeconds: 1800,
      nowInstant: NOW_INSTANT,
    });
    expect(claims["exp"]).toBe(2_000_000_000);
    expect(claims["iat"]).toBe(2_000_000_000 - 1800);
  });

  it("floors only the FINAL iat, applying a sub-second --valid-for before truncating (CLI-1961)", () => {
    const claims = buildBearerJwtClaims({
      role: "anon",
      sub: Option.none(),
      expiresAt: Option.some({ wholeSeconds: 1_893_456_000, nanos: 0 }),
      validForSeconds: 1.5,
      nowInstant: NOW_INSTANT,
    });
    expect(claims["exp"]).toBe(1_893_456_000);
    expect(claims["iat"]).toBe(1_893_455_998);
  });

  it("preserves a fractional --exp through the iat subtraction, flooring only the final result (CLI-1961 Codex review finding)", () => {
    const claims = buildBearerJwtClaims({
      role: "anon",
      sub: Option.none(),
      expiresAt: Option.some({ wholeSeconds: 1_893_456_000, nanos: 900_000_000 }),
      validForSeconds: 1.2,
      nowInstant: NOW_INSTANT,
    });
    expect(claims["exp"]).toBe(1_893_456_000);
    expect(claims["iat"]).toBe(1_893_455_999);
  });

  it("floors exp down (never rounds up) for a near-second nanosecond --exp fraction (CLI-1961 Codex review finding)", () => {
    const claims = buildBearerJwtClaims({
      role: "anon",
      sub: Option.none(),
      expiresAt: Option.some({ wholeSeconds: 1_893_456_000, nanos: 999_999_999 }),
      validForSeconds: 1800,
      nowInstant: NOW_INSTANT,
    });
    expect(claims["exp"]).toBe(1_893_456_000);
  });

  it("adds a sub-second --valid-for to the unfloored current time when --exp is omitted (CLI-1961 Codex review finding)", () => {
    const claims = buildBearerJwtClaims({
      role: "anon",
      sub: Option.none(),
      expiresAt: Option.none(),
      validForSeconds: 0.2,
      nowInstant: { wholeSeconds: NOW, nanos: 900_000_000 },
    });
    expect(claims["iat"]).toBe(NOW);
    expect(claims["exp"]).toBe(NOW + 1);
  });

  it("sets is_anonymous when --sub is explicitly passed as an empty string (CLI-1961)", () => {
    const claims = buildBearerJwtClaims({
      role: "authenticated",
      sub: Option.some(""),
      expiresAt: Option.none(),
      validForSeconds: 1800,
      nowInstant: NOW_INSTANT,
    });
    expect(claims["is_anonymous"]).toBe(true);
    expect("sub" in claims).toBe(false);
  });

  it("sets is_anonymous when role is 'authenticated' (case-insensitive) and sub is absent", () => {
    const claims = buildBearerJwtClaims({
      role: "AUTHENTICATED",
      sub: Option.none(),
      expiresAt: Option.none(),
      validForSeconds: 1800,
      nowInstant: NOW_INSTANT,
    });
    expect(claims["is_anonymous"]).toBe(true);
    expect(claims["role"]).toBe("AUTHENTICATED");
  });

  it("does not set is_anonymous when role is authenticated but sub is given", () => {
    const claims = buildBearerJwtClaims({
      role: "authenticated",
      sub: Option.some("user-1"),
      expiresAt: Option.none(),
      validForSeconds: 1800,
      nowInstant: NOW_INSTANT,
    });
    expect(claims["is_anonymous"]).toBeUndefined();
    expect(claims["sub"]).toBe("user-1");
  });

  it("does not set is_anonymous for a non-authenticated role", () => {
    const claims = buildBearerJwtClaims({
      role: "postgres",
      sub: Option.none(),
      expiresAt: Option.none(),
      validForSeconds: 1800,
      nowInstant: NOW_INSTANT,
    });
    expect(claims["is_anonymous"]).toBeUndefined();
  });

  it("omits sub entirely when not given (omitempty)", () => {
    const claims = buildBearerJwtClaims({
      role: "service_role",
      sub: Option.none(),
      expiresAt: Option.none(),
      validForSeconds: 1800,
      nowInstant: NOW_INSTANT,
    });
    expect("sub" in claims).toBe(false);
  });
});

describe("mergeBearerJwtPayload", () => {
  it("is a no-op for the default '{}' payload", () => {
    const claims = { role: "anon" };
    expect(mergeBearerJwtPayload(claims, "{}")).toEqual({ role: "anon" });
  });

  it("merges payload keys on top of (overriding) existing claims", () => {
    const claims = { role: "postgres", exp: 1, iat: 2 };
    const merged = mergeBearerJwtPayload(
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
    expect(mergeBearerJwtPayload(claims, "null")).toEqual({ role: "anon" });
  });

  it("rejects an array payload with Go's unmarshal-type-mismatch message", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, "[]")).toThrow(
      "json: cannot unmarshal array into Go value of type jwt.MapClaims",
    );
  });

  it("rejects a scalar number payload with Go's unmarshal-type-mismatch message", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, "123")).toThrow(
      "json: cannot unmarshal number into Go value of type jwt.MapClaims",
    );
  });

  it("rejects a scalar string payload with Go's unmarshal-type-mismatch message", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, '"str"')).toThrow(
      "json: cannot unmarshal string into Go value of type jwt.MapClaims",
    );
  });

  it("rejects a scalar boolean payload with Go's unmarshal-type-mismatch message", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, "true")).toThrow(
      "json: cannot unmarshal bool into Go value of type jwt.MapClaims",
    );
  });

  it("rejects an empty payload with Go's exact 'unexpected end of JSON input'", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, "")).toThrow(
      "unexpected end of JSON input",
    );
  });

  it("rejects an overflowing number nested in an object payload instead of silently signing Infinity-as-null (CLI-1961 Codex review finding)", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, '{"extra":1e309}')).toThrow(
      "json: cannot unmarshal number 1e309 into Go value of type float64",
    );
  });

  it("rejects an overflowing number nested arbitrarily deep (inside an array, inside an object)", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, '{"a":{"b":[1,2,1e309]}}')).toThrow(
      "json: cannot unmarshal number 1e309 into Go value of type float64",
    );
  });

  it("reports the FIRST overflowing literal in document order when multiple numbers overflow", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, '{"a":1e400,"b":1e309}')).toThrow(
      "json: cannot unmarshal number 1e400 into Go value of type float64",
    );
  });

  it("does not misreport a non-overflowing number as overflowing", () => {
    const merged = mergeBearerJwtPayload({ role: "anon" }, '{"extra":123.456}');
    expect(merged["extra"]).toBe(123.456);
  });

  it("prioritizes the top-level type-mismatch message over an overflowing scalar payload", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, "1e309")).toThrow(
      "json: cannot unmarshal number into Go value of type jwt.MapClaims",
    );
  });

  it("prioritizes the top-level array-mismatch message over an overflowing number nested inside the array", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, "[1e309]")).toThrow(
      "json: cannot unmarshal array into Go value of type jwt.MapClaims",
    );
  });

  it("rejects trailing garbage after a valid value with Go's exact 'after top-level value' text", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, "{}{}")).toThrow(
      "invalid character '{' after top-level value",
    );
  });

  it("accepts a payload value of null for an individual key (distinct from a null top-level payload)", () => {
    const merged = mergeBearerJwtPayload({ role: "anon", sub: "x" }, '{"sub":null}');
    expect(merged["sub"]).toBeNull();
  });

  it("reports a partial keyword match against Go's exact 'in literal' wording", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, "not-json-at-all")).toThrow(
      "invalid character 'o' in literal null (expecting 'u')",
    );
  });

  it("rejects a truncated object with Go's exact 'unexpected end of JSON input'", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, '{"a":1')).toThrow(
      "unexpected end of JSON input",
    );
  });

  it("rejects a truncated array with Go's exact 'unexpected end of JSON input'", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, "[1,2")).toThrow(
      "unexpected end of JSON input",
    );
  });

  it("rejects an object truncated inside a nested unterminated string", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, '{"a')).toThrow(
      "unexpected end of JSON input",
    );
  });

  it("reports trailing garbage after a validly nested container, not on the inner close", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, "{[]}x")).toThrow(
      "invalid character 'x' after top-level value",
    );
  });

  it("rejects an unterminated string with Go's exact 'unexpected end of JSON input'", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, '"unterminated')).toThrow(
      "unexpected end of JSON input",
    );
  });

  it("reports trailing garbage after a valid string value", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, '"abc"def')).toThrow(
      "invalid character 'd' after top-level value",
    );
  });

  it("skips over an escaped quote inside a string when finding where it closes", () => {
    // Payload bytes: `"a\"b"c` — a string with an escaped quote, then trailing garbage `c`.
    expect(() => mergeBearerJwtPayload({ role: "anon" }, '"a\\"b"c')).toThrow(
      "invalid character 'c' after top-level value",
    );
  });

  it("rejects a truncated literal (a strict prefix of a keyword) as truncated, not a mismatch", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, "tru")).toThrow(
      "unexpected end of JSON input",
    );
  });

  it("reports trailing garbage after a FULLY matched literal keyword", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, "nullx")).toThrow(
      "invalid character 'x' after top-level value",
    );
  });

  it("rejects a lone digit-less minus sign with Go's exact 'unexpected end of JSON input'", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, "-")).toThrow(
      "unexpected end of JSON input",
    );
  });

  it("reports trailing garbage after a valid number value", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, "123abc")).toThrow(
      "invalid character 'a' after top-level value",
    );
  });

  it("reports the actual first invalid character for a byte that can never start a value", () => {
    expect(() => mergeBearerJwtPayload({ role: "anon" }, "@")).toThrow(
      "invalid character '@' looking for beginning of value",
    );
  });

  it("falls back to the generic message when the only valid prefix is the WHOLE trimmed string", () => {
    // A vertical tab is JS `\s` whitespace but not valid JSON whitespace, so
    // `JSON.parse` still fails even though the rest ("{}") is valid JSON.
    // Built via `String.fromCharCode` to avoid a raw control byte in the source.
    const verticalTab = String.fromCharCode(11);
    expect(() => mergeBearerJwtPayload({ role: "anon" }, `${verticalTab}{}`)).toThrow(
      "invalid character looking for beginning of value",
    );
  });
});

describe("encodeBearerJwtClaims", () => {
  it("serializes claims with alphabetically sorted keys, matching Go's jwt.MapClaims", () => {
    const claims = { role: "authenticated", is_anonymous: true, exp: 200, iat: 100 };
    expect(encodeBearerJwtClaims(claims)).toBe(
      '{"exp":200,"iat":100,"is_anonymous":true,"role":"authenticated"}',
    );
  });

  it("HTML-escapes special characters like Go's default json.Marshal", () => {
    const claims = { role: "a<b>&c" };
    expect(encodeBearerJwtClaims(claims)).toBe('{"role":"a\\u003cb\\u003e\\u0026c"}');
  });

  it("sorts nested object keys recursively too", () => {
    const claims = { role: "anon", custom: { z: 1, a: 2 } };
    expect(encodeBearerJwtClaims(claims)).toBe('{"custom":{"a":2,"z":1},"role":"anon"}');
  });

  it("keeps Go's true lexicographic order for numeric-looking custom claim keys (CLI-1961 Codex review finding)", () => {
    // JS objects reorder integer-like string keys into ascending numeric order on
    // enumeration, but Go's lexicographic string-key sort keeps "10" before "2".
    const claims = { role: "anon", 10: "a", 2: "b" };
    expect(encodeBearerJwtClaims(claims)).toBe('{"10":"a","2":"b","role":"anon"}');
  });
});
