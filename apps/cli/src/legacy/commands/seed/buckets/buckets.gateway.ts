import { Effect, FileSystem } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacySeedStorageNetworkError, LegacySeedStorageStatusError } from "./buckets.errors.ts";

/**
 * Native TypeScript client for the Supabase Storage **service gateway** (Kong),
 * mirroring `apps/cli-go/pkg/storage/{buckets,objects,vector}.go` and the
 * `fetcher.NewServiceGateway` auth headers: the `apikey` header is always sent,
 * and `Authorization: Bearer <key>` is added only when the key is a JWT — Go's
 * `withAuthToken` (`pkg/fetcher/gateway.go:22`) omits it for opaque `sb_...`
 * keys, which are not bearer tokens.
 *
 * Scope is limited to what `seed buckets` reaches against the **local** stack
 * (list/create/update buckets, upload objects, vector list/create/delete). No
 * TS gateway client existed before this port (storage ls/cp/mv/rm are still Go
 * proxies); this is the hoist candidate for `legacy/shared/` once those land.
 */

interface LegacyBucketSummary {
  readonly name: string;
  readonly id: string;
}

export interface LegacyUpsertBucketProps {
  /**
   * Tri-state to match Go's `Public *bool` with `json:"public,omitempty"`:
   * `undefined` when `public` is absent from the bucket's TOML (field omitted),
   * otherwise the explicit value.
   */
  readonly public: boolean | undefined;
  /** Byte count; omitted from the request body when 0 (Go `omitempty`). */
  readonly fileSizeLimit: number;
  readonly allowedMimeTypes: ReadonlyArray<string>;
}

export interface LegacyStorageGateway {
  readonly listBuckets: () => Effect.Effect<
    ReadonlyArray<LegacyBucketSummary>,
    LegacySeedStorageNetworkError | LegacySeedStorageStatusError
  >;
  readonly createBucket: (
    name: string,
    props: LegacyUpsertBucketProps,
  ) => Effect.Effect<void, LegacySeedStorageNetworkError | LegacySeedStorageStatusError>;
  readonly updateBucket: (
    id: string,
    props: LegacyUpsertBucketProps,
  ) => Effect.Effect<void, LegacySeedStorageNetworkError | LegacySeedStorageStatusError>;
  readonly listVectorBuckets: () => Effect.Effect<
    ReadonlyArray<string>,
    LegacySeedStorageNetworkError | LegacySeedStorageStatusError
  >;
  readonly createVectorBucket: (
    name: string,
  ) => Effect.Effect<void, LegacySeedStorageNetworkError | LegacySeedStorageStatusError>;
  readonly deleteVectorBucket: (
    name: string,
  ) => Effect.Effect<void, LegacySeedStorageNetworkError | LegacySeedStorageStatusError>;
  readonly uploadObject: (
    remotePath: string,
    absPath: string,
    contentType: string,
  ) => Effect.Effect<void, LegacySeedStorageNetworkError | LegacySeedStorageStatusError>;
  readonly listAnalyticsBuckets: () => Effect.Effect<
    ReadonlyArray<string>,
    LegacySeedStorageNetworkError | LegacySeedStorageStatusError
  >;
  readonly createAnalyticsBucket: (
    name: string,
  ) => Effect.Effect<void, LegacySeedStorageNetworkError | LegacySeedStorageStatusError>;
  readonly deleteAnalyticsBucket: (
    name: string,
  ) => Effect.Effect<void, LegacySeedStorageNetworkError | LegacySeedStorageStatusError>;
}

/**
 * Strict JSON decode mirroring Go's `fetcher.ParseJSON[T]`
 * (`pkg/fetcher/http.go` — `json.NewDecoder(r).Decode(&data)`): a body whose
 * shape doesn't match the typed target aborts before any bucket mutation. Only
 * missing fields, `null` (decoded as the zero-value struct/field), empty arrays,
 * and extra keys are tolerated (zero values); a non-matching top-level type, a
 * non-null non-object element (number/array/string), or a present-but-wrong-typed
 * string field all fail. The graceful-skip classifiers
 * never see these (the message doesn't match), so they propagate, like Go.
 */
function failParse(detail: string): LegacySeedStorageNetworkError {
  return new LegacySeedStorageNetworkError({ message: `failed to parse response body: ${detail}` });
}

/**
 * The port to use for the local-gateway port-conflict hint, mirroring Go's
 * `localGatewayHint` (`apps/cli-go/pkg/fetcher/http.go:117-143`), which parses
 * the configured **server URL**: the hint only fires for a loopback host
 * (`127.0.0.1`/`localhost`/`::1`) that has a port, and reports THAT URL's port —
 * not `api.port`, which can differ when `api.external_url` is overridden. Returns
 * undefined for a non-loopback/remote host (so `--linked` never gets the hint).
 */
function localGatewayHintPort(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.replace(/^\[|\]$/g, ""); // WHATWG brackets IPv6
    if ((host === "127.0.0.1" || host === "localhost" || host === "::1") && url.port.length > 0) {
      return url.port;
    }
  } catch {
    // Unparseable base URL → no hint.
  }
  return undefined;
}

/**
 * Byte-identical to Go's `localGatewayHint` message. Go gates on its net/http
 * error strings (`malformed HTTP response` / timeout); Bun/undici don't emit
 * those, so the caller gates on an Effect `TransportError` instead — the text is
 * unchanged. Hoist to `legacy/shared/` when `storage ls/cp/mv/rm` land.
 */
function legacyLocalGatewayHint(port: string): string {
  return (
    "The local Supabase API gateway did not return a valid HTTP response. " +
    `Another process may be listening on the configured API port ${port}. ` +
    `Check the port with \`lsof -nP -iTCP:${port} -sTCP:LISTEN\`, then stop the conflicting process or set a different \`api.port\` in supabase/config.toml.`
  );
}

/**
 * Whether a transport failure is a plain connection-refused (the local stack is
 * stopped). Go's `localGatewayHint` only fires for a malformed HTTP response,
 * header timeout, or context-deadline timeout — NOT `ECONNREFUSED` — so the
 * port-conflict hint is suppressed for refused connections. Bun/undici don't
 * emit Go's net/http strings, so this is a substring check over the transport
 * error's description/cause/message.
 */
function isConnectionRefused(error: HttpClientError.TransportError): boolean {
  const detail =
    `${error.description ?? ""} ${String(error.cause ?? "")} ${error.message}`.toLowerCase();
  return /econnrefused|connection ?refused|unable to connect/.test(detail);
}

const parseJsonBody = (body: string): Effect.Effect<unknown, LegacySeedStorageNetworkError> =>
  Effect.try({
    try: () => JSON.parse(body) as unknown,
    catch: (cause) => failParse(String(cause)),
  });

/**
 * A JSON object → itself; a JSON `null` → `{}` (Go's zero-value struct: decoding
 * `null` into a non-pointer struct is a no-op that leaves it zero, no error —
 * same `encoding/json` rule as the string-field level below); a number / array /
 * string → `null` to signal a real Go-struct decode failure (`encoding/json`
 * errors on those). Combined with the null-tolerant `decodeStringField`, a `null`
 * list element decodes to the zero-value struct (empty `name`/`id`) and the
 * upsert loops continue, exactly as Go's do.
 */
function asObject(entry: unknown): Record<string, unknown> | null {
  if (entry === null) return {};
  return typeof entry === "object" && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)
    : null;
}

/**
 * Go-struct string field: absent OR JSON `null` → "" (zero value, tolerated).
 * Go decodes via `json.NewDecoder(...).Decode(&data)` (fetcher/http.go:144-151)
 * into plain `string` fields (not `*string`), and `encoding/json` leaves a
 * non-pointer scalar at its zero value for a `null` JSON value rather than
 * erroring — so `{"name": null}` is `Name == ""`, not a parse failure. A
 * present-but-not-a-string value → `null` (decode failure, matching Go's
 * type-mismatch error). Distinguish the failure via `=== null`.
 */
function decodeStringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : null;
}

/** Decode an array body of `{name, id}` objects (Go `[]BucketResponse`). */
const decodeBucketSummaries = (
  body: string,
): Effect.Effect<ReadonlyArray<LegacyBucketSummary>, LegacySeedStorageNetworkError> =>
  Effect.gen(function* () {
    const parsed = yield* parseJsonBody(body);
    if (parsed === null) return [];
    if (!Array.isArray(parsed)) {
      return yield* Effect.fail(failParse("expected an array of buckets"));
    }
    const result: Array<LegacyBucketSummary> = [];
    for (const entry of parsed) {
      const obj = asObject(entry);
      const name = obj === null ? null : decodeStringField(obj, "name");
      const id = obj === null ? null : decodeStringField(obj, "id");
      if (name === null || id === null) {
        return yield* Effect.fail(failParse("invalid bucket entry"));
      }
      result.push({ name, id });
    }
    return result;
  });

/** Decode the `{vectorBuckets: [{vectorBucketName}]}` body (Go `ListVectorBucketsResponse`). */
const decodeVectorBucketNames = (
  body: string,
): Effect.Effect<ReadonlyArray<string>, LegacySeedStorageNetworkError> =>
  Effect.gen(function* () {
    const parsed = yield* parseJsonBody(body);
    const root = asObject(parsed);
    if (root === null) {
      return yield* Effect.fail(failParse("expected a vector bucket list object"));
    }
    const list = root["vectorBuckets"];
    // Absent or null → empty: Go decodes `{"vectorBuckets": null}` (and the
    // zero `ListVectorBucketsResponse{}`) into a nil slice, i.e. no buckets.
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) {
      return yield* Effect.fail(failParse("vectorBuckets must be an array"));
    }
    const names: Array<string> = [];
    for (const entry of list) {
      const obj = asObject(entry);
      const name = obj === null ? null : decodeStringField(obj, "vectorBucketName");
      if (name === null) {
        return yield* Effect.fail(failParse("invalid vector bucket entry"));
      }
      names.push(name);
    }
    return names;
  });

/**
 * Validate a create/update bucket success body. Go's `CreateBucket`/`UpdateBucket`
 * decode the 200 body via `fetcher.ParseJSON` into `{name}`/`{message}`
 * (`pkg/storage/buckets.go:46,65`) and fail on a non-JSON/empty body before later
 * uploads. The decoded value is unused (Go ignores it too) — this is purely the
 * validity gate. `null` is tolerated (Go's `json.Decode` accepts it); a non-object
 * top-level or a present-but-wrong-typed field fails.
 */
const decodeMutationResponse = (
  body: string,
  field: string,
): Effect.Effect<void, LegacySeedStorageNetworkError> =>
  Effect.gen(function* () {
    const parsed = yield* parseJsonBody(body);
    if (parsed === null) return;
    const obj = asObject(parsed);
    if (obj === null || decodeStringField(obj, field) === null) {
      return yield* Effect.fail(
        failParse(`invalid ${field === "name" ? "create" : "update"} bucket response`),
      );
    }
  });

/** Decode an array body of `{name, ...}` objects to names (Go `[]AnalyticsBucketResponse`). */
const decodeAnalyticsBucketNames = (
  body: string,
): Effect.Effect<ReadonlyArray<string>, LegacySeedStorageNetworkError> =>
  Effect.gen(function* () {
    const parsed = yield* parseJsonBody(body);
    if (parsed === null) return [];
    if (!Array.isArray(parsed)) {
      return yield* Effect.fail(failParse("expected an array of analytics buckets"));
    }
    const names: Array<string> = [];
    for (const entry of parsed) {
      const obj = asObject(entry);
      const name = obj === null ? null : decodeStringField(obj, "name");
      if (name === null) {
        return yield* Effect.fail(failParse("invalid analytics bucket entry"));
      }
      names.push(name);
    }
    return names;
  });

/**
 * Build the create/update bucket body with Go's `omitempty` semantics
 * (`pkg/storage/buckets.go:29-54`): `public` (a `*bool`) is omitted when absent
 * from the TOML, `file_size_limit` when 0, `allowed_mime_types` when empty.
 * Exported for focused unit coverage.
 */
export function legacyBucketBody(props: LegacyUpsertBucketProps): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (props.public !== undefined) {
    body["public"] = props.public;
  }
  if (props.fileSizeLimit > 0) {
    body["file_size_limit"] = props.fileSizeLimit;
  }
  if (props.allowedMimeTypes.length > 0) {
    body["allowed_mime_types"] = props.allowedMimeTypes;
  }
  return body;
}

export const legacyMakeStorageGateway = Effect.fnUntraced(function* (opts: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly userAgent: string;
}) {
  const httpClient = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;

  // Port for Go's local-gateway hint, derived from the actual base URL: only a
  // loopback host with a port qualifies (so remote/custom hosts never get it).
  const hintPort = localGatewayHintPort(opts.baseUrl);

  // Map a transport/request failure to a network error, appending Go's
  // local-gateway port-conflict hint when the base URL is a local loopback
  // gateway and the failure is at the transport layer (`localGatewayHint`).
  const networkError = (cause: unknown): LegacySeedStorageNetworkError => {
    const base = `failed to execute http request: ${cause}`;
    if (
      hintPort !== undefined &&
      HttpClientError.isHttpClientError(cause) &&
      cause.reason._tag === "TransportError" &&
      !isConnectionRefused(cause.reason)
    ) {
      return new LegacySeedStorageNetworkError({
        message: `${base}\n\n${legacyLocalGatewayHint(hintPort)}`,
      });
    }
    return new LegacySeedStorageNetworkError({ message: base });
  };

  // Go's `withAuthToken` (`pkg/fetcher/gateway.go:22`) gates the bearer header on
  // a plain `sb_` prefix check: opaque `sb_...` keys are not JWTs, so only the
  // `apikey` header is sent for them.
  const isOpaqueServiceKey = opts.apiKey.startsWith("sb_");
  const withAuth = (
    req: HttpClientRequest.HttpClientRequest,
  ): HttpClientRequest.HttpClientRequest => {
    const withApiKey = req.pipe(
      HttpClientRequest.setHeader("apikey", opts.apiKey),
      HttpClientRequest.setHeader("User-Agent", opts.userAgent),
    );
    return isOpaqueServiceKey
      ? withApiKey
      : withApiKey.pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${opts.apiKey}`));
  };

  // Sends a request and returns the response body text, reproducing the Go
  // fetcher's error shapes (`pkg/fetcher/http.go`): transport failure →
  // network error; non-200 → `Error status <d>: <body>` status error. Go's
  // service gateway installs `WithExpectedStatus(http.StatusOK)`
  // (`pkg/fetcher/gateway.go:17`), so only exactly 200 is a success — a 201/204
  // from an incompatible route is an error, not a silent pass.
  const send = Effect.fnUntraced(function* (req: HttpClientRequest.HttpClientRequest) {
    const { status, body } = yield* Effect.gen(function* () {
      const response = yield* httpClient.execute(req);
      const text = yield* response.text;
      return { status: response.status, body: text };
    }).pipe(Effect.mapError(networkError));
    if (status !== 200) {
      return yield* Effect.fail(
        new LegacySeedStorageStatusError({
          status,
          body,
          message: `Error status ${status}: ${body}`,
        }),
      );
    }
    return body;
  });

  const url = (path: string) => `${opts.baseUrl}${path}`;

  const gateway: LegacyStorageGateway = {
    listBuckets: () =>
      send(withAuth(HttpClientRequest.get(url("/storage/v1/bucket")))).pipe(
        Effect.flatMap(decodeBucketSummaries),
      ),
    createBucket: (name, props) =>
      send(
        withAuth(HttpClientRequest.post(url("/storage/v1/bucket"))).pipe(
          HttpClientRequest.bodyJsonUnsafe({ name, ...legacyBucketBody(props) }),
        ),
      ).pipe(Effect.flatMap((body) => decodeMutationResponse(body, "name"))),
    updateBucket: (id, props) =>
      send(
        withAuth(HttpClientRequest.put(url(`/storage/v1/bucket/${id}`))).pipe(
          HttpClientRequest.bodyJsonUnsafe(legacyBucketBody(props)),
        ),
      ).pipe(Effect.flatMap((body) => decodeMutationResponse(body, "message"))),
    listVectorBuckets: () =>
      send(
        withAuth(HttpClientRequest.post(url("/storage/v1/vector/ListVectorBuckets"))).pipe(
          HttpClientRequest.bodyJsonUnsafe({}),
        ),
      ).pipe(Effect.flatMap(decodeVectorBucketNames)),
    createVectorBucket: (name) =>
      send(
        withAuth(HttpClientRequest.post(url("/storage/v1/vector/CreateVectorBucket"))).pipe(
          HttpClientRequest.bodyJsonUnsafe({ vectorBucketName: name }),
        ),
      ).pipe(Effect.asVoid),
    deleteVectorBucket: (name) =>
      send(
        withAuth(HttpClientRequest.post(url("/storage/v1/vector/DeleteVectorBucket"))).pipe(
          HttpClientRequest.bodyJsonUnsafe({ vectorBucketName: name }),
        ),
      ).pipe(Effect.asVoid),
    listAnalyticsBuckets: () =>
      send(withAuth(HttpClientRequest.get(url("/storage/v1/iceberg/bucket")))).pipe(
        Effect.flatMap(decodeAnalyticsBucketNames),
      ),
    createAnalyticsBucket: (name) =>
      send(
        withAuth(HttpClientRequest.post(url("/storage/v1/iceberg/bucket"))).pipe(
          HttpClientRequest.bodyJsonUnsafe({ bucketName: name }),
        ),
      ).pipe(Effect.asVoid),
    deleteAnalyticsBucket: (name) =>
      send(
        withAuth(HttpClientRequest.make("DELETE")(url(`/storage/v1/iceberg/bucket/${name}`))),
      ).pipe(Effect.asVoid),
    uploadObject: (remotePath, absPath, contentType) => {
      const trimmed = remotePath.startsWith("/") ? remotePath.slice(1) : remotePath;
      const req = withAuth(HttpClientRequest.post(url(`/storage/v1/object/${trimmed}`))).pipe(
        HttpClientRequest.setHeader("Cache-Control", "max-age=3600"),
        HttpClientRequest.setHeader("x-upsert", "true"),
      );
      // `bodyFile` stats the file for Content-Length and streams it via
      // FileSystem rather than buffering — the analogue of Go's open-and-stream
      // upload. The captured FileSystem is supplied here so the gateway's public
      // Effect type stays free of a service requirement.
      return HttpClientRequest.bodyFile(req, absPath, { contentType }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError(
          (cause) =>
            new LegacySeedStorageNetworkError({
              message: `failed to execute http request: ${cause}`,
            }),
        ),
        Effect.flatMap(send),
        Effect.asVoid,
      );
    },
  };

  return gateway;
});
