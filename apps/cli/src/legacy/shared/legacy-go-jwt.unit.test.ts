import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { legacyGenerateGoJwt } from "./legacy-go-jwt.ts";

const SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";

function decodeSegment(segment: string): string {
  return Buffer.from(segment, "base64url").toString("utf8");
}

describe("legacyGenerateGoJwt", () => {
  it("emits Go's exact JWT header (no extra fields, alg before typ)", () => {
    const token = legacyGenerateGoJwt(SECRET, "anon");
    const [header] = token.split(".");
    expect(header).toBeDefined();
    // Go's jwt.NewWithClaims builds Header as map[string]any{"typ":..,"alg":..};
    // encoding/json marshals map keys in sorted order, so "alg" sorts before "typ".
    expect(decodeSegment(header ?? "")).toBe('{"alg":"HS256","typ":"JWT"}');
  });

  it("emits the anon payload with Go's exact key order and fixed claims", () => {
    const token = legacyGenerateGoJwt(SECRET, "anon");
    const [, payload] = token.split(".");
    expect(payload).toBeDefined();
    const raw = decodeSegment(payload ?? "");
    // Byte-exact key order: iss, role, exp — ref/is_anonymous/iat are omitted
    // entirely (Go's `omitempty`), matching status's no-ref, non-anonymous use.
    expect(raw).toBe('{"iss":"supabase-demo","role":"anon","exp":1983812996}');

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed).toEqual({ iss: "supabase-demo", role: "anon", exp: 1983812996 });
    expect(Object.keys(parsed)).not.toContain("iat");
    expect(Object.keys(parsed)).not.toContain("ref");
    expect(Object.keys(parsed)).not.toContain("is_anonymous");
  });

  it("emits the service_role payload with Go's exact key order and fixed claims", () => {
    const token = legacyGenerateGoJwt(SECRET, "service_role");
    const [, payload] = token.split(".");
    const raw = decodeSegment(payload ?? "");
    expect(raw).toBe('{"iss":"supabase-demo","role":"service_role","exp":1983812996}');
  });

  it("signs with plain HMAC-SHA256 over the base64url header.payload, base64url-encoded", () => {
    const token = legacyGenerateGoJwt(SECRET, "anon");
    const [header, payload, signature] = token.split(".");
    const expectedSignature = createHmac("sha256", SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(signature).toBe(expectedSignature);
  });

  it("is deterministic across calls (no timestamp derived from Date.now())", () => {
    const first = legacyGenerateGoJwt(SECRET, "anon");
    const second = legacyGenerateGoJwt(SECRET, "anon");
    expect(first).toBe(second);
  });

  it("produces different tokens for different secrets", () => {
    const a = legacyGenerateGoJwt(SECRET, "anon");
    const b = legacyGenerateGoJwt("a-different-secret-value-1234567", "anon");
    expect(a).not.toBe(b);
  });
});
