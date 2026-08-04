import { Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  legacyBuildBearerJwtClaims,
  legacyEncodeBearerJwtClaims,
  legacyGoJsonKindName,
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

  it("falls back to a generic message for malformed JSON with no valid prefix at all", () => {
    // Accepted gap (see this module's own doc comment): `bearerjwt_test.go` has no
    // `--payload` parsing fixture at all, so this exact wording is not Go-verified.
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, "not-json-at-all")).toThrow(
      "invalid character looking for beginning of value",
    );
  });

  it("falls back to the generic message when the only valid prefix is the WHOLE trimmed string", () => {
    // A leading vertical tab is in JS's `\s` regex class (so `trimmed` strips it) but is
    // NOT valid JSON whitespace (so the original `JSON.parse(payload)` call still fails
    // on it) — the longest-valid-prefix loop's first (longest) candidate then succeeds
    // with nothing left over, which must fall through to the generic message rather than
    // reporting on an empty `rest`. Built via `String.fromCharCode` rather than a literal
    // escape so no raw control byte sits in the source file.
    const verticalTab = String.fromCharCode(11);
    expect(() => legacyMergeBearerJwtPayload({ role: "anon" }, `${verticalTab}{}`)).toThrow(
      "invalid character looking for beginning of value",
    );
  });
});

describe("legacyGoJsonKindName", () => {
  it("names every JSON-representable kind, including the generic fallback", () => {
    expect(legacyGoJsonKindName([])).toBe("array");
    expect(legacyGoJsonKindName(1)).toBe("number");
    expect(legacyGoJsonKindName("s")).toBe("string");
    expect(legacyGoJsonKindName(true)).toBe("bool");
    // Never reachable from real JSON.parse output (both call sites already exclude
    // null/array/object before calling this) — exercised directly for completeness.
    expect(legacyGoJsonKindName(undefined)).toBe("value");
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
