/**
 * Auth headers for a request through the local Kong service gateway: `apikey`
 * is always sent; `Authorization: Bearer <key>` is added only when the key is
 * a JWT — an opaque `sb_...` secret key is not a bearer token.
 *
 * Shared by every local Kong-gateway caller across command families
 * (Storage, `start`'s PostgREST readiness probe).
 */
export function kongAuthHeaders(apiKey: string): Readonly<Record<string, string>> {
  const isOpaqueServiceKey = apiKey.startsWith("sb_");
  return isOpaqueServiceKey
    ? { apikey: apiKey }
    : { apikey: apiKey, Authorization: `Bearer ${apiKey}` };
}
