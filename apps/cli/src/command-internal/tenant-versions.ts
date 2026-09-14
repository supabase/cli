import { Effect, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/**
 * Best-effort probes for the deployed versions of a project's REST, Auth,
 * and Storage services, used by `supabase link`. Requests use the
 * service-role key: always `apikey: <serviceKey>`, plus `Authorization:
 * Bearer <serviceKey>` unless the key is a new-style `sb_…` key. Any
 * transport error, non-200 status, parse failure, or missing version
 * resolves to `Option.none()` instead of failing the link.
 */

interface TenantVersionOptions {
  readonly ref: string;
  readonly projectHost: string;
  readonly serviceKey: string;
  readonly userAgent: string;
}

/**
 * PostgREST advertises its version in the OpenAPI/Swagger `info.version`
 * field at `GET /rest/v1/`. Returns the first whitespace-delimited token,
 * prefixed with `v`.
 */
export function parsePostgrestVersion(body: unknown): Option.Option<string> {
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
 * GoTrue reports its version in the `version` field of `GET /auth/v1/health`.
 * Returned verbatim (no `v` prefix).
 */
export function parseGotrueVersion(body: unknown): Option.Option<string> {
  if (typeof body !== "object" || body === null) return Option.none();
  const version = (body as { version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) return Option.none();
  return Option.some(version);
}

/**
 * Storage returns its bare version string at `GET /storage/v1/version`. An
 * empty body or the `0.0.0` sentinel means "not found"; otherwise the body is
 * prefixed with `v`.
 */
export function parseStorageVersion(body: string): Option.Option<string> {
  if (body.length === 0 || body === "0.0.0") return Option.none();
  return Option.some(`v${body}`);
}

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

export const fetchPostgrestVersion = (
  opts: TenantVersionOptions,
): Effect.Effect<Option.Option<string>, never, HttpClient.HttpClient> =>
  fetchJson(tenantRequest(opts, "/rest/v1/")).pipe(
    Effect.map((body) =>
      Option.isNone(body) ? Option.none<string>() : parsePostgrestVersion(body.value),
    ),
  );

export const fetchGotrueVersion = (
  opts: TenantVersionOptions,
): Effect.Effect<Option.Option<string>, never, HttpClient.HttpClient> =>
  fetchJson(tenantRequest(opts, "/auth/v1/health")).pipe(
    Effect.map((body) =>
      Option.isNone(body) ? Option.none<string>() : parseGotrueVersion(body.value),
    ),
  );

export const fetchStorageVersion = (
  opts: TenantVersionOptions,
): Effect.Effect<Option.Option<string>, never, HttpClient.HttpClient> =>
  fetchText(tenantRequest(opts, "/storage/v1/version")).pipe(
    Effect.map((body) =>
      Option.isNone(body) ? Option.none<string>() : parseStorageVersion(body.value),
    ),
  );
