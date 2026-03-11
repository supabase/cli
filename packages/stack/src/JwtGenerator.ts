import { createHmac } from "node:crypto";
import { Effect, Layer, ServiceMap } from "effect";

// Hardcoded opaque key defaults matching Go CLI (pkg/config/apikeys.go:19-20).
// These are client-facing keys for local dev — SDKs use these, not JWTs directly.
export const defaultPublishableKey = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
export const defaultSecretKey = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

/** Well-known dev JWT secret. NOT for production use. */
export const defaultJwtSecret = "super-secret-jwt-token-with-at-least-32-characters-long";

/**
 * Pure synchronous JWT generation. Used both by the JwtGenerator service
 * and directly in createStack() where JWTs are needed before layers run.
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

export class JwtGenerator extends ServiceMap.Service<
  JwtGenerator,
  {
    readonly generate: (secret: string, role: string) => Effect.Effect<string>;
  }
>()("local/JwtGenerator") {
  static layer: Layer.Layer<JwtGenerator> = Layer.succeed(this, {
    generate: (secret: string, role: string) => Effect.sync(() => generateJwt(secret, role)),
  });
}
