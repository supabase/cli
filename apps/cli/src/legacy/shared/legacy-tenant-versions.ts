import { Effect, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/**
 * Best-effort probes for the deployed versions of a project's REST (PostgREST),
 * Auth (GoTrue) and Storage services. Mirrors `apps/cli-go/internal/utils/tenant/
 * {postgrest,gotrue,storage}.go`, which `supabase link`'s `LinkServices` calls to
 * write `rest-version` / `gotrue-version` / `storage-version` under
 * `supabase/.temp/`.
 *
 * Requests go directly to the project's service gateway
 * (`https://<ref>.<projectHost>`) using the service-role key, replicating Go's
 * `fetcher.NewServiceGateway` auth headers (`apps/cli-go/pkg/fetcher/gateway.go:25-31`):
 *  - always send `apikey: <serviceKey>`;
 *  - additionally send `Authorization: Bearer <serviceKey>` unless the key is a
 *    new-style `sb_…` key (which carries auth in the `apikey` header alone).
 *
 * Every probe is best-effort: any transport error, non-200 status, parse failure,
 * or empty/sentinel version resolves to `Option.none()` so the caller skips the
 * corresponding file write without failing the link. This matches Go, where each
 * job's error is only logged to the debug logger.
 */

interface TenantVersionOptions {
  readonly ref: string;
  readonly projectHost: string;
  readonly serviceKey: string;
  readonly userAgent: string;
}

// ---------------------------------------------------------------------------
// Pure parsers — exported for focused unit coverage.
// ---------------------------------------------------------------------------

/**
 * PostgREST advertises its version in the OpenAPI/Swagger `info.version` field at
 * `GET /rest/v1/`. Go takes the first whitespace-delimited token and prefixes it
 * with `v` (`postgrest.go:37-40`).
 */
export function parseLegacyPostgrestVersion(body: unknown): Option.Option<string> {
  if (typeof body !== "object" || body === null) return Option.none();
  const info = (body as { info?: unknown }).info;
  if (typeof info !== "object" || info === null) return Option.none();
  const version = (info as { version?: unknown }).version;
  if (typeof version !== "string" || version.trim().length === 0) return Option.none();
  const first = version.trim().split(/\s+/)[0];
  if (first === undefined || first.length === 0) return Option.none();
  return Option.some(`v${first}`);
}

/**
 * GoTrue reports its version in the `version` field of `GET /auth/v1/health`
 * (`gotrue.go:28-31`). Returned verbatim (no `v` prefix).
 */
export function parseLegacyGotrueVersion(body: unknown): Option.Option<string> {
  if (typeof body !== "object" || body === null) return Option.none();
  const version = (body as { version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) return Option.none();
  return Option.some(version);
}

/**
 * Storage returns its bare version string at `GET /storage/v1/version`. Go treats
 * an empty body or the `0.0.0` sentinel as "not found" and otherwise prefixes the
 * body with `v` (`storage.go:25-28`).
 */
export function parseLegacyStorageVersion(body: string): Option.Option<string> {
  if (body.length === 0 || body === "0.0.0") return Option.none();
  return Option.some(`v${body}`);
}

// ---------------------------------------------------------------------------
// Effectful probes.
// ---------------------------------------------------------------------------

function tenantRequest(opts: TenantVersionOptions, pathName: string) {
  let request = HttpClientRequest.get(`https://${opts.ref}.${opts.projectHost}${pathName}`).pipe(
    HttpClientRequest.setHeader("apikey", opts.serviceKey),
    HttpClientRequest.setHeader("User-Agent", opts.userAgent),
  );
  if (!opts.serviceKey.startsWith("sb_")) {
    request = request.pipe(
      HttpClientRequest.setHeader("Authorization", `Bearer ${opts.serviceKey}`),
    );
  }
  return request;
}

const fetchJson = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.execute(request);
    if (response.status !== 200) return Option.none<unknown>();
    return Option.some(yield* response.json);
  }).pipe(Effect.catch(() => Effect.succeed(Option.none<unknown>())));

const fetchText = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.execute(request);
    if (response.status !== 200) return Option.none<string>();
    return Option.some(yield* response.text);
  }).pipe(Effect.catch(() => Effect.succeed(Option.none<string>())));

export const legacyFetchPostgrestVersion = (
  opts: TenantVersionOptions,
): Effect.Effect<Option.Option<string>, never, HttpClient.HttpClient> =>
  fetchJson(tenantRequest(opts, "/rest/v1/")).pipe(
    Effect.map((body) =>
      Option.isNone(body) ? Option.none<string>() : parseLegacyPostgrestVersion(body.value),
    ),
  );

export const legacyFetchGotrueVersion = (
  opts: TenantVersionOptions,
): Effect.Effect<Option.Option<string>, never, HttpClient.HttpClient> =>
  fetchJson(tenantRequest(opts, "/auth/v1/health")).pipe(
    Effect.map((body) =>
      Option.isNone(body) ? Option.none<string>() : parseLegacyGotrueVersion(body.value),
    ),
  );

export const legacyFetchStorageVersion = (
  opts: TenantVersionOptions,
): Effect.Effect<Option.Option<string>, never, HttpClient.HttpClient> =>
  fetchText(tenantRequest(opts, "/storage/v1/version")).pipe(
    Effect.map((body) =>
      Option.isNone(body) ? Option.none<string>() : parseLegacyStorageVersion(body.value),
    ),
  );
