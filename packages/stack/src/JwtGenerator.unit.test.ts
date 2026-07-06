import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defaultJwtSecret, generateJwks, generateJwt } from "./JwtGenerator.ts";

describe("JwtGenerator", () => {
  it("generates HS256 JWTs", () => {
    const before = Math.floor(Date.now() / 1000);
    const role = "anon";
    const jwt = generateJwt(defaultJwtSecret, role);
    const after = Math.floor(Date.now() / 1000);
    const [header, payload, signature] = jwt.split(".");

    expect(JSON.parse(Buffer.from(header!, "base64url").toString("utf8"))).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))).toEqual({
      role,
      iss: "supabase",
      iat: expect.any(Number),
      exp: expect.any(Number),
    });

    const decodedPayload = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as {
      readonly iat: number;
      readonly exp: number;
    };
    expect(decodedPayload.iat).toBeGreaterThanOrEqual(before);
    expect(decodedPayload.iat).toBeLessThanOrEqual(after);
    expect(decodedPayload.exp).toBe(decodedPayload.iat + 60 * 60 * 24 * 365 * 10);
    expect(signature).toBe(
      createHmac("sha256", defaultJwtSecret).update(`${header}.${payload}`).digest("base64url"),
    );
  });

  it("generates an oct JWKS from the local JWT secret", () => {
    expect(JSON.parse(generateJwks(defaultJwtSecret))).toEqual({
      keys: [
        {
          kty: "oct",
          k: Buffer.from(defaultJwtSecret).toString("base64url"),
        },
      ],
    });
  });
});
