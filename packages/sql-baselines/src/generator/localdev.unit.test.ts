import { describe, expect, it } from "vitest";
import { LOCAL_DEV, localDevJwks, signLocalDevJwt } from "./localdev.ts";

describe("signLocalDevJwt", () => {
  // The well-known local-dev API keys the Go CLI generates from the default
  // JWT secret (`apps/cli-go/pkg/config/apikeys.go`). If these drift, the
  // storage migrate job would run with different env than `db start` uses.
  it("reproduces the CLI's default anon key byte-for-byte", () => {
    expect(signLocalDevJwt("anon", LOCAL_DEV.jwtSecret)).toBe(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
    );
  });

  it("reproduces the CLI's default service_role key byte-for-byte", () => {
    expect(signLocalDevJwt("service_role", LOCAL_DEV.jwtSecret)).toBe(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
    );
  });
});

describe("localDevJwks", () => {
  it("contains the public signing key and the oct fallback of the JWT secret", () => {
    const jwks = JSON.parse(localDevJwks(LOCAL_DEV.jwtSecret)) as {
      keys: Array<Record<string, unknown>>;
    };
    expect(jwks.keys).toHaveLength(2);
    expect(jwks.keys[0]).toMatchObject({ kty: "EC", alg: "ES256", key_ops: ["verify"] });
    // Public-only: the private exponent must never leak into the JWKS.
    expect(jwks.keys[0]).not.toHaveProperty("d");
    expect(jwks.keys[1]).toEqual({
      kty: "oct",
      k: Buffer.from(LOCAL_DEV.jwtSecret).toString("base64url"),
    });
  });
});
