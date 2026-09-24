/** JWT secret used by local development services when no secret is configured. */
export const DEFAULT_LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";

export { DEFAULT_LOCAL_TLS_CERT, DEFAULT_LOCAL_TLS_KEY } from "./LocalTls.ts";

/** Default local ES256 signing key shared with the legacy CLI. */
export const DEFAULT_SIGNING_KEY = {
  kty: "EC",
  kid: "b81269f1-21d8-4f2e-b719-c2240a840d90",
  use: "sig",
  key_ops: ["sign", "verify"],
  alg: "ES256",
  ext: true,
  crv: "P-256",
  x: "M5Sjqn5zwC9Kl1zVfUUGvv9boQjCGd45G8sdopBExB4",
  y: "P6IXMvA2WYXSHSOMTBH2jsw_9rrzGy89FjPf6oOsIxQ",
  d: "dIhR8wywJlqlua4y_yMq2SLhlFXDZJBCvFrY1DCHyVU",
};

/** Root key used by local development PostgreSQL instances when none is configured. */
export const DEFAULT_POSTGRES_ROOT_KEY =
  "d4dc5b6d4a1d6a10b2c1e76112c994d65db7cec380572cc1839624d4be3fa275";

/** Password for the local PostgreSQL database. */
export const DEFAULT_LOCAL_DATABASE_PASSWORD = "postgres";
/** Publishable API key for local services. */
export const DEFAULT_LOCAL_PUBLISHABLE_KEY = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
/** Secret API key for local services. */
export const DEFAULT_LOCAL_SECRET_KEY = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
/** Access key ID for local Storage S3 requests. */
export const DEFAULT_LOCAL_S3_ACCESS_KEY_ID = "625729a08b95bf1b7ff351a663f3a23c";
/** Secret access key for local Storage S3 requests. */
export const DEFAULT_LOCAL_S3_SECRET_ACCESS_KEY =
  "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907";
/** Region for local Storage S3 requests. */
export const DEFAULT_LOCAL_S3_REGION = "local";
/** Key used to encrypt local Realtime database settings. */
export const DEFAULT_REALTIME_DB_ENCRYPTION_KEY = "supabaserealtime";
/** Key used by the local Realtime service to sign sessions. */
export const DEFAULT_LOCAL_SERVICE_SECRET_KEY_BASE =
  "EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG";
/** Key used to encrypt local Pooler tenant secrets. */
export const DEFAULT_POOLER_VAULT_ENCRYPTION_KEY = "12345678901234567890123456789032";
