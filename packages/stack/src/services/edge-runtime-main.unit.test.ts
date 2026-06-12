import { afterEach, describe, expect, it, vi } from "vitest";
import { generateJwks, generateJwt } from "../JwtGenerator.ts";
import { areClaimsValid, verifyHybridJwt } from "./edge-runtime-main.ts";

const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const SUPABASE_URL = "http://localhost:54321";

function b64url(value: string | Uint8Array): string {
  return Buffer.from(value as Uint8Array).toString("base64url");
}

const asymmetricParams = {
  ES256: {
    generate: { name: "ECDSA", namedCurve: "P-256" },
    sign: { name: "ECDSA", hash: "SHA-256" },
  },
  RS256: {
    generate: {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    sign: { name: "RSASSA-PKCS1-v1_5" },
  },
} as const;

async function generateAsymmetricKey(alg: keyof typeof asymmetricParams, kid?: string) {
  const pair = await crypto.subtle.generateKey(asymmetricParams[alg].generate, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, jwk: { ...jwk, ...(kid ? { kid } : {}) } };
}

async function mintAsymmetricJwt(opts: {
  alg: keyof typeof asymmetricParams;
  privateKey: CryptoKey;
  kid?: string;
  claims?: Record<string, unknown>;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: opts.alg, typ: "JWT", ...(opts.kid ? { kid: opts.kid } : {}) };
  const payload = {
    role: "authenticated",
    iss: "supabase",
    iat: now,
    exp: now + 3600,
    ...opts.claims,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    asymmetricParams[opts.alg].sign,
    opts.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("verifyHybridJwt — HS256 legacy path", () => {
  const config = {
    jwtSecret: JWT_SECRET,
    jwks: generateJwks(JWT_SECRET),
    supabaseUrl: SUPABASE_URL,
  };

  it("accepts a token signed with the symmetric secret", async () => {
    const token = generateJwt(JWT_SECRET, "anon");
    expect(await verifyHybridJwt(config, token)).toBe(true);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const token = generateJwt("a-different-secret-at-least-32-characters-long", "anon");
    expect(await verifyHybridJwt(config, token)).toBe(false);
  });

  it("rejects a malformed token", async () => {
    expect(await verifyHybridJwt(config, "not-a-jwt")).toBe(false);
  });
});

describe.each(["ES256", "RS256"] as const)("verifyHybridJwt — %s asymmetric path", (alg) => {
  it("verifies a token against the auth service's well-known JWKS", async () => {
    const { privateKey, jwk } = await generateAsymmetricKey(alg, "key-1");
    const token = await mintAsymmetricJwt({ alg, privateKey, kid: "key-1" });
    const fetchMock = vi.fn(async () => Response.json({ keys: [jwk] }));
    vi.stubGlobal("fetch", fetchMock);
    const supabaseUrl = `http://asym-accept-${alg.toLowerCase()}.test`;
    const config = { jwtSecret: JWT_SECRET, jwks: generateJwks(JWT_SECRET), supabaseUrl };
    expect(await verifyHybridJwt(config, token)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
  });

  it("rejects a token signed by a key absent from the JWKS", async () => {
    const signer = await generateAsymmetricKey(alg, "key-1");
    const other = await generateAsymmetricKey(alg, "key-2");
    const token = await mintAsymmetricJwt({ alg, privateKey: signer.privateKey, kid: "key-1" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ keys: [other.jwk] })),
    );
    const config = {
      jwtSecret: JWT_SECRET,
      jwks: generateJwks(JWT_SECRET),
      supabaseUrl: `http://asym-absent-${alg.toLowerCase()}.test`,
    };
    expect(await verifyHybridJwt(config, token)).toBe(false);
  });

  it("excludes keys whose kid does not match the token", async () => {
    const { privateKey, jwk } = await generateAsymmetricKey(alg, "real-kid");
    const token = await mintAsymmetricJwt({ alg, privateKey, kid: "wrong-kid" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ keys: [jwk] })),
    );
    const config = {
      jwtSecret: JWT_SECRET,
      jwks: generateJwks(JWT_SECRET),
      supabaseUrl: `http://asym-kid-${alg.toLowerCase()}.test`,
    };
    expect(await verifyHybridJwt(config, token)).toBe(false);
  });

  it("matches keyless JWKS entries when the token carries a kid", async () => {
    const { privateKey, jwk } = await generateAsymmetricKey(alg);
    const token = await mintAsymmetricJwt({ alg, privateKey, kid: "any-kid" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ keys: [jwk] })),
    );
    const config = {
      jwtSecret: JWT_SECRET,
      jwks: generateJwks(JWT_SECRET),
      supabaseUrl: `http://asym-keyless-${alg.toLowerCase()}.test`,
    };
    expect(await verifyHybridJwt(config, token)).toBe(true);
  });

  it("refetches the remote JWKS after the cache TTL expires", async () => {
    const signer = await generateAsymmetricKey(alg, "rotated");
    const stale = await generateAsymmetricKey(alg, "old");
    const token = await mintAsymmetricJwt({ alg, privateKey: signer.privateKey, kid: "rotated" });
    const supabaseUrl = `http://remote-rotation-${alg.toLowerCase()}.test`;
    const config = { jwtSecret: JWT_SECRET, jwks: generateJwks(JWT_SECRET), supabaseUrl };

    let currentKeys = [stale.jwk];
    const fetchMock = vi.fn(async () => Response.json({ keys: currentKeys }));
    vi.stubGlobal("fetch", fetchMock);
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    // Only the stale key is published, so the token misses and is rejected.
    expect(await verifyHybridJwt(config, token)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Within the TTL the cached (stale) set is reused — still a miss, no refetch.
    clock += 60_000;
    expect(await verifyHybridJwt(config, token)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // After the TTL elapses the rotated-in key is fetched and verifies.
    currentKeys = [signer.jwk];
    clock += 5 * 60 * 1000;
    expect(await verifyHybridJwt(config, token)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("verifyHybridJwt — claim validation", () => {
  const config = {
    jwtSecret: JWT_SECRET,
    jwks: generateJwks(JWT_SECRET),
    supabaseUrl: SUPABASE_URL,
  };

  it("rejects an expired token even with a valid signature", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify({ role: "anon", iat: now - 7200, exp: now - 3600 }));
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", JWT_SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(await verifyHybridJwt(config, `${header}.${payload}.${signature}`)).toBe(false);
  });

  it("rejects a not-yet-valid (nbf) token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = b64url(
      JSON.stringify({ role: "anon", iat: now, nbf: now + 3600, exp: now + 7200 }),
    );
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", JWT_SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(await verifyHybridJwt(config, `${header}.${payload}.${signature}`)).toBe(false);
  });

  it("rejects a JSON null payload without throwing past the gate", async () => {
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = b64url("null");
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", JWT_SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(await verifyHybridJwt(config, `${header}.${payload}.${signature}`)).toBe(false);
  });
});

describe("areClaimsValid", () => {
  const now = Math.floor(Date.now() / 1000);

  it("accepts a token with no temporal claims", () => {
    expect(areClaimsValid(b64url(JSON.stringify({ role: "anon" })))).toBe(true);
  });

  it("tolerates clock skew around exp", () => {
    expect(areClaimsValid(b64url(JSON.stringify({ exp: now - 30 })))).toBe(true);
    expect(areClaimsValid(b64url(JSON.stringify({ exp: now - 120 })))).toBe(false);
  });

  it("rejects non-numeric exp/nbf claims", () => {
    expect(areClaimsValid(b64url(JSON.stringify({ exp: "9999999999" })))).toBe(false);
    expect(areClaimsValid(b64url(JSON.stringify({ nbf: "1" })))).toBe(false);
  });

  it("rejects non-object payloads", () => {
    expect(areClaimsValid(b64url("null"))).toBe(false);
    expect(areClaimsValid(b64url(JSON.stringify("a-string")))).toBe(false);
    expect(areClaimsValid(b64url(JSON.stringify([])))).toBe(false);
  });

  it("returns false for an undecodable payload", () => {
    expect(areClaimsValid("!!!not-base64-json")).toBe(false);
  });
});
