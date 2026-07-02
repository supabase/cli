import { createHmac } from "node:crypto";

/**
 * Go-byte-exact HS256 signer for the default local-dev `anon`/`service_role`
 * keys, ported from `CustomClaims`/`generateJWT` (`apps/cli-go/pkg/config/apikeys.go:23-40,75-86`).
 *
 * This intentionally does NOT reuse `@supabase/stack`'s `generateJwt`
 * (`packages/stack/src/JwtGenerator.ts`) — that helper uses `iss:"supabase"`,
 * a dynamic `iat`/10-year `exp`, and a different claim order, none of which
 * byte-match what Go prints for `supabase status`. Go's claims, in
 * declaration order (the outer `CustomClaims.Issuer` field shadows the
 * embedded `jwt.RegisteredClaims.Issuer`, so only one `iss` key is emitted):
 *
 *   iss (fixed "supabase-demo"), ref (omitempty), role, is_anonymous (omitempty),
 *   then the remaining `jwt.RegisteredClaims` fields (sub, aud, exp, nbf, iat, jti),
 *   all `omitempty` except `exp`, which Go always sets to the fixed
 *   `defaultJwtExpiry = 1983812996` unix timestamp (never computed from "now").
 *
 * `status` never sets `ref`/`is_anonymous`, so for this signer's two roles the
 * payload always serializes to exactly `{"iss":...,"role":...,"exp":...}`.
 */

const GO_JWT_ISSUER = "supabase-demo";
const GO_JWT_FIXED_EXP = 1983812996;

function base64UrlEncode(input: string): string {
  return Buffer.from(input).toString("base64url");
}

export function legacyGenerateGoJwt(secret: string, role: "anon" | "service_role"): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({ iss: GO_JWT_ISSUER, role, exp: GO_JWT_FIXED_EXP }),
  );
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}
