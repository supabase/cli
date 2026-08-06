/**
 * Auth headers for a request through the local Kong service gateway, mirroring
 * Go's `fetcher.withAuthToken` (`apps/cli-go/pkg/fetcher/gateway.go:22-34`):
 * `apikey` is always sent; `Authorization: Bearer <key>` is added only when the
 * key is a JWT — an opaque `sb_...` secret key is not a bearer token, so Go's
 * `sb_` prefix check omits the header for those.
 *
 * Hoisted here because it is needed by every local Kong-gateway caller across
 * command families: `legacy-storage-gateway.ts` (Storage, `seed buckets` /
 * `storage ls/cp/mv/rm`) and `start`'s PostgREST HTTP-HEAD readiness probe
 * (`legacy/shared/db-bootstrap/health-check.ts`).
 */
export function legacyKongAuthHeaders(apiKey: string): Readonly<Record<string, string>> {
  const isOpaqueServiceKey = apiKey.startsWith("sb_");
  return isOpaqueServiceKey
    ? { apikey: apiKey }
    : { apikey: apiKey, Authorization: `Bearer ${apiKey}` };
}
