import { describe, expect, it } from "vitest";

import { toPublicJwk } from "./jwks.ts";

describe("toPublicJwk", () => {
  it("omits key_ops entirely for an RSA key whose ops filter down to none, matching Go's omitempty", () => {
    const result = toPublicJwk({ kty: "RSA", key_ops: ["sign"], n: "abc", e: "AQAB" });
    expect(result.key_ops).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("key_ops");
  });

  it("omits key_ops entirely for an EC key whose ops filter down to none, matching Go's omitempty", () => {
    const result = toPublicJwk({ kty: "EC", key_ops: ["sign"], crv: "P-256", x: "abc", y: "def" });
    expect(result.key_ops).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("key_ops");
  });

  it("keeps only the verify entry when key_ops mixes sign and verify", () => {
    const result = toPublicJwk({ kty: "RSA", key_ops: ["sign", "verify"], n: "abc", e: "AQAB" });
    expect(result.key_ops).toEqual(["verify"]);
  });

  it("leaves key_ops undefined when the input never set it", () => {
    const result = toPublicJwk({ kty: "RSA", n: "abc", e: "AQAB" });
    expect(result.key_ops).toBeUndefined();
  });
});
