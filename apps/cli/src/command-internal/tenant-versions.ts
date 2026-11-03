import { Duration, Effect, Option, Predicate } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import { tagForServiceVersion } from "../shared/services/services.shared.ts";

/**
 * Best-effort probes for the deployed versions of a project's REST, Auth,
 * and Storage services, used by `supabase link`. Requests use the
 * service-role key: always `apikey: <serviceKey>`, plus `Authorization:
 * Bearer <serviceKey>` unless the key is a new-style `sb_…` key. The legacy
 * fetchers resolve any transport error, non-200 status, parse failure, or
 * missing version to `Option.none()`; {@link probeTenantVersions} keeps
 * "the service does not report a version" apart from "the probe failed".
 */

export interface TenantVersionOptions {
  readonly ref: string;
  readonly projectHost: string;
  readonly serviceKey: string;
  readonly userAgent: string;
}

/**
 * PostgREST's OpenAPI `info.version` at `GET /rest/v1/`. The first
 * whitespace-delimited token becomes the image tag. Empty means not found.
 */
export function parsePostgrestVersion(body: unknown): Option.Option<string> {
  return Option.map(postgrestRaw(body), (raw) => tagForServiceVersion("postgrest", raw));
}

function postgrestRaw(body: unknown): Option.Option<string> {
  if (typeof body !== "object" || body === null) return Option.none();
  const info = (body as { info?: unknown }).info;
  if (typeof info !== "object" || info === null) return Option.none();
  const version = (info as { version?: unknown }).version;
  if (typeof version !== "string" || version.trim().length === 0) return Option.none();
  const first = version.trim().split(/\s+/)[0];
  return first === undefined || first.length === 0 ? Option.none() : Option.some(first);
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
 * Storage's `GET /storage/v1/version` body. Empty or `0.0.0` means not found.
 * Any other body becomes the storage image tag.
 */
export function parseStorageVersion(body: string): Option.Option<string> {
  return Option.map(storageRaw(body), (raw) => tagForServiceVersion("storage", raw));
}

function storageRaw(body: string): Option.Option<string> {
  const version = body.trim();
  return version.length === 0 || version === "0.0.0" ? Option.none() : Option.some(version);
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

/** Fetch keeps the `apikey` header across a cross-origin redirect, so a tenant 3xx is returned, never followed. */
const executeTenant = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return yield* httpClient
      .execute(request)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  });

const fetchJson = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const response = yield* executeTenant(request);
    if (response.status !== 200) return Option.none<unknown>();
    return Option.some(yield* response.json);
  }).pipe(Effect.orElseSucceed(() => Option.none<unknown>()));

const fetchText = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const response = yield* executeTenant(request);
    if (response.status !== 200) return Option.none<string>();
    return Option.some(yield* response.text);
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

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

/** What probing a hosted service for its version found. */
export type HostedObservation =
  | {
      readonly _tag: "Observed";
      /** The value the platform reported. */
      readonly raw: string;
      /** The upstream version, spelled as its release tag. */
      readonly version: string;
    }
  | { readonly _tag: "Unreported" }
  | { readonly _tag: "Failed"; readonly cause: string };

type Fetched<A> =
  | { readonly _tag: "Body"; readonly body: A }
  | { readonly _tag: "Unreported" }
  | { readonly _tag: "Failed"; readonly cause: string };

export const probeFailure = (
  error: unknown,
): { readonly _tag: "Failed"; readonly cause: string } => ({
  _tag: "Failed",
  cause: Predicate.hasProperty(error, "_tag")
    ? `request failed (${String(error._tag)})`
    : "request failed",
});

const PROBE_REQUEST_TIMEOUT = Duration.seconds(10);

/** A 404 means the service has no version endpoint; any other non-200 status is a failed probe. */
const fetchBody = <A, E>(
  request: HttpClientRequest.HttpClientRequest,
  read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>,
): Effect.Effect<Fetched<A>, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* executeTenant(request);
    if (response.status === 404) return { _tag: "Unreported" } as const;
    if (response.status !== 200)
      return { _tag: "Failed", cause: `HTTP ${response.status}` } as const;
    return { _tag: "Body", body: yield* read(response) } as const;
  }).pipe(
    Effect.timeout(PROBE_REQUEST_TIMEOUT),
    Effect.catch((error) => Effect.succeed(probeFailure(error))),
  );

const probeService = <A, E>(
  opts: TenantVersionOptions,
  service: "postgrest" | "auth" | "storage",
  pathName: string,
  read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>,
  rawOf: (body: A) => Option.Option<string>,
) =>
  fetchBody(tenantRequest(opts, pathName), read).pipe(
    Effect.map((fetched): HostedObservation => {
      if (fetched._tag !== "Body") return fetched;
      return Option.match(rawOf(fetched.body), {
        onNone: () => ({ _tag: "Unreported" }),
        onSome: (raw) => ({ _tag: "Observed", raw, version: tagForServiceVersion(service, raw) }),
      });
    }),
  );

/** The hosted versions the tenant endpoints report; Realtime and the other services have no endpoint. */
interface TenantObservations {
  readonly auth: HostedObservation;
  readonly rest: HostedObservation;
  readonly storage: HostedObservation;
}

/**
 * Probes `rest`, `auth` and `storage` on the project's tenant host, concurrently. A service that
 * answers 404 or an empty version is `Unreported`; a transport error or any other status is `Failed`.
 * Without a key nothing is probed and every service is `Failed`.
 */
export const probeTenantVersions = Effect.fn("TenantVersions.probe")(function* (
  opts: TenantVersionOptions,
) {
  if (opts.serviceKey.length === 0) {
    const skipped: HostedObservation = { _tag: "Failed", cause: "no API key to probe with" };
    return { auth: skipped, rest: skipped, storage: skipped } satisfies TenantObservations;
  }
  const [rest, auth, storage] = yield* Effect.all(
    [
      probeService(opts, "postgrest", "/rest/v1/", (response) => response.json, postgrestRaw),
      probeService(
        opts,
        "auth",
        "/auth/v1/health",
        (response) => response.json,
        parseGotrueVersion,
      ),
      probeService(opts, "storage", "/storage/v1/version", (response) => response.text, storageRaw),
    ],
    { concurrency: 3 },
  );
  const observations: TenantObservations = { auth, rest, storage };
  const found = Object.values(observations);
  yield* Effect.annotateCurrentSpan({
    "tenant.observed_count": found.filter(({ _tag }) => _tag === "Observed").length,
    "tenant.failed_count": found.filter(({ _tag }) => _tag === "Failed").length,
  });
  return observations;
});
