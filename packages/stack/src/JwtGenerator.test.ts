import { describe, expect, it } from "vitest";
import { defaultJwtSecret, generateJwks, generateJwt } from "./JwtGenerator.ts";

describe("JwtGenerator", () => {
  it("generates HS256 JWTs", () => {
    const jwt = generateJwt(defaultJwtSecret, "anon");
    const [header, payload, signature] = jwt.split(".");

    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();
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
