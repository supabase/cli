import { createHmac } from "node:crypto";

/**
 * The canonical determinism tuple for v1: the CLI local-dev configuration.
 * Values mirror the defaults in `apps/cli-go/pkg/config` (single-tenant
 * storage, `install_roles=false`, no orioledb, fixed local-dev keys). Bundles
 * are only valid for consumers running this exact tuple; anything else falls
 * back to the service's own migrate job.
 */
export const LOCAL_DEV = {
  dbPassword: "postgres",
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  /** `auth.jwt_expiry` from a stock config.toml (not the API-key exp). */
  jwtExpiry: 3600,
  siteUrl: "http://127.0.0.1:3000",
  authExternalUrl: "http://127.0.0.1:54321/auth/v1",
  pgsodiumRootKey: "d4dc5b6d4a1d6a10b2c1e76112c994d65db7cec380572cc1839624d4be3fa275",
  realtime: {
    tenantId: "realtime-dev",
    encryptionKey: "supabaserealtime",
    secretKeyBase: "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG",
    maxHeaderLength: 4096,
    erlAflags: "-proto_dist inet_tcp",
  },
  storage: {
    fileSizeLimitBytes: 52428800,
  },
  /** Default ES256 signing key from `apps/cli-go/pkg/config/config.go`. */
  signingKeyPublicJwk: {
    kty: "EC",
    kid: "b81269f1-21d8-4f2e-b719-c2240a840d90",
    use: "sig",
    key_ops: ["verify"],
    alg: "ES256",
    ext: true,
    crv: "P-256",
    x: "M5Sjqn5zwC9Kl1zVfUUGvv9boQjCGd45G8sdopBExB4",
    y: "P6IXMvA2WYXSHSOMTBH2jsw_9rrzGy89FjPf6oOsIxQ",
  },
} as const;

const base64Url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

/**
 * Deterministic HS256 JWT with the exact claims the Go CLI signs API keys
 * with (`apps/cli-go/pkg/config/apikeys.go`): fixed issuer and expiry, so the
 * output is a stable function of (role, secret).
 */
export const signLocalDevJwt = (role: "anon" | "service_role", secret: string): string => {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iss: "supabase-demo", role, exp: 1983812996 }));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
};

/**
 * The JWKS the CLI passes to realtime's migrate job (`auth.ResolveJWKS` with
 * no third-party providers): public part of the default signing key plus the
 * JWT secret as an `oct` JWK for backward compatibility.
 */
export const localDevJwks = (secret: string): string =>
  JSON.stringify({
    keys: [LOCAL_DEV.signingKeyPublicJwk, { kty: "oct", k: base64Url(secret) }],
  });
