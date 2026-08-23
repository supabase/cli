// oxlint-disable effecttsgo/global-date -- JWT generation is a synchronous config-boundary helper that stamps wall-clock claims.
import { createHmac } from "node:crypto";

// Hardcoded opaque key defaults matching Go CLI (pkg/config/apikeys.go:19-20).
// These are client-facing keys for local dev — SDKs use these, not JWTs directly.
export const defaultPublishableKey = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
export const defaultSecretKey = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

/** Well-known dev JWT secret. NOT for production use. */
export const defaultJwtSecret = "super-secret-jwt-token-with-at-least-32-characters-long";

/**
 * Pure synchronous JWT generation used while resolving stack configuration.
 */
export function generateJwt(secret: string, role: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      role,
      iss: "supabase",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 10,
    }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

export function generateJwks(secret: string): string {
  return JSON.stringify({
    keys: [
      {
        kty: "oct",
        k: Buffer.from(secret).toString("base64url"),
      },
    ],
  });
}
