import { Effect, FileSystem, Stream } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  LegacyStorageGatewayNetworkError,
  LegacyStorageGatewayStatusError,
} from "./legacy-storage-gateway.errors.ts";
import { legacyGoPathSplit } from "./legacy-storage-url.ts";

/**
 * Native TypeScript client for the Supabase Storage **service gateway** (Kong),
 * mirroring `apps/cli-go/pkg/storage/{buckets,objects,vector,api}.go` and the
 * `fetcher.NewServiceGateway` auth headers: the `apikey` header is always sent,
 * and `Authorization: Bearer <key>` is added only when the key is a JWT — Go's
 * `withAuthToken` (`pkg/fetcher/gateway.go:22`) omits it for opaque `sb_...`
 * keys, which are not bearer tokens.
 *
 * Shared by `seed buckets` (bucket/object/vector upsert against the local stack)
 * and `storage ls/cp/mv/rm` (object list/download/move/delete + bucket delete).
 */

/** `pkg/storage/api.go:9-11`. */
export const LEGACY_PAGE_LIMIT = 100;
export const LEGACY_DELETE_OBJECTS_LIMIT = 1000;

interface LegacyBucketSummary {
  readonly name: string;
  readonly id: string;
}

/** A `/storage/v1/object/list/{bucket}` entry: a directory when Go's `Id == nil`. */
interface LegacyStorageObject {
  readonly name: string;
  readonly isDir: boolean;
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

/** Upload headers, mirroring Go's `FileOptions` (`pkg/storage/objects.go:60-64`). */
interface LegacyUploadObjectOptions {
  readonly contentType: string;
  readonly cacheControl: string;
  readonly overwrite: boolean;
}

export interface LegacyStorageGateway {
  readonly listBuckets: () => Effect.Effect<
    ReadonlyArray<LegacyBucketSummary>,
    LegacyStorageGatewayNetworkError | LegacyStorageGatewayStatusError
  >;
  readonly createBucket: (
    name: string,
    props: LegacyUpsertBucketProps,
  ) => Effect.Effect<void, LegacyStorageGatewayNetworkError | LegacyStorageGatewayStatusError>;
  readonly updateBucket: (
    id: string,
    props: LegacyUpsertBucketProps,
  ) => Effect.Effect<void, LegacyStorageGatewayNetworkError | LegacyStorageGatewayStatusError>;
  readonly deleteBucket: (
    id: string,
  ) => Effect.Effect<string, LegacyStorageGatewayNetworkError | LegacyStorageGatewayStatusError>;
  readonly listObjects: (
    bucket: string,
    prefix: string,
    page: number,
  ) => Effect.Effect<
    ReadonlyArray<LegacyStorageObject>,
    LegacyStorageGatewayNetworkError | LegacyStorageGatewayStatusError
  >;
  /** Streams the object body; fails before the first byte on a non-200 status. */
  readonly downloadObject: (
    remotePath: string,
  ) => Stream.Stream<
    Uint8Array,
    LegacyStorageGatewayNetworkError | LegacyStorageGatewayStatusError
  >;
  readonly uploadObject: (
    remotePath: string,
    absPath: string,
    options: LegacyUploadObjectOptions,
  ) => Effect.Effect<void, LegacyStorageGatewayNetworkError | LegacyStorageGatewayStatusError>;
  readonly moveObject: (
    bucketId: string,
    srcKey: string,
    dstKey: string,
  ) => Effect.Effect<string, LegacyStorageGatewayNetworkError | LegacyStorageGatewayStatusError>;
  readonly deleteObjects: (
    bucket: string,
    prefixes: ReadonlyArray<string>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly name: string }>,
    LegacyStorageGatewayNetworkError | LegacyStorageGatewayStatusError
  >;
  readonly listVectorBuckets: () => Effect.Effect<
    ReadonlyArray<string>,
    LegacyStorageGatewayNetworkError | LegacyStorageGatewayStatusError
  >;
  readonly createVectorBucket: (
    name: string,
  ) => Effect.Effect<void, LegacyStorageGatewayNetworkError | LegacyStorageGatewayStatusError>;
  readonly deleteVectorBucket: (
    name: string,
  ) => Effect.Effect<void, LegacyStorageGatewayNetworkError | LegacyStorageGatewayStatusError>;
  readonly listAnalyticsBuckets: () => Effect.Effect<
    ReadonlyArray<string>,
    LegacyStorageGatewayNetworkError | LegacyStorageGatewayStatusError
  >;
  readonly createAnalyticsBucket: (
    name: string,
  ) => Effect.Effect<void, LegacyStorageGatewayNetworkError | LegacyStorageGatewayStatusError>;
  readonly deleteAnalyticsBucket: (
    name: string,
  ) => Effect.Effect<void, LegacyStorageGatewayNetworkError | LegacyStorageGatewayStatusError>;
}

/**
 * Strict JSON decode mirroring Go's `fetcher.ParseJSON[T]`
 * (`pkg/fetcher/http.go` — `json.NewDecoder(r).Decode(&data)`): a body whose
 * shape doesn't match the typed target aborts. Only missing fields, `null`
 * (decoded as the zero value), empty arrays, and extra keys are tolerated; a
 * non-matching top-level type, a non-null non-object element, or a
 * present-but-wrong-typed string field fail.
 */
function failParse(detail: string): LegacyStorageGatewayNetworkError {
  return new LegacyStorageGatewayNetworkError({
    message: `failed to parse response body: ${detail}`,
  });
}

/**
 * Port for Go's `localGatewayHint` (`pkg/fetcher/http.go:117-143`): the
 * port-conflict hint fires only for a loopback host with a port, reporting THAT
 * URL's port (not `api.port`, which can differ when `api.external_url` is set).
 */
function localGatewayHintPort(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if ((host === "127.0.0.1" || host === "localhost" || host === "::1") && url.port.length > 0) {
      return url.port;
    }
  } catch {
    // Unparseable base URL → no hint.
  }
  return undefined;
}

/** Byte-identical to Go's `localGatewayHint` message. */
function legacyLocalGatewayHint(port: string): string {
  return (
    "The local Supabase API gateway did not return a valid HTTP response. " +
    `Another process may be listening on the configured API port ${port}. ` +
    `Check the port with \`lsof -nP -iTCP:${port} -sTCP:LISTEN\`, then stop the conflicting process or set a different \`api.port\` in supabase/config.toml.`
  );
}

/**
 * Whether a transport failure is a plain connection-refused. Go's
 * `localGatewayHint` fires only for malformed-response / timeout — NOT
 * `ECONNREFUSED` — so the port-conflict hint is suppressed for refused
 * connections.
 */
function isConnectionRefused(error: HttpClientError.TransportError): boolean {
  const detail =
    `${error.description ?? ""} ${String(error.cause ?? "")} ${error.message}`.toLowerCase();
  return /econnrefused|connection ?refused|unable to connect/.test(detail);
}

const parseJsonBody = (body: string): Effect.Effect<unknown, LegacyStorageGatewayNetworkError> =>
  Effect.try({
    try: () => JSON.parse(body) as unknown,
    catch: (cause) => failParse(String(cause)),
  });

/** A JSON object → itself; `null` → `{}` (Go zero-value struct); other → `null`. */
function asObject(entry: unknown): Record<string, unknown> | null {
  if (entry === null) return {};
  return typeof entry === "object" && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)
    : null;
}

/** Go-struct string field: absent/`null` → ""; wrong type → `null` (decode failure). */
function decodeStringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : null;
}

const decodeBucketSummaries = (
  body: string,
): Effect.Effect<ReadonlyArray<LegacyBucketSummary>, LegacyStorageGatewayNetworkError> =>
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

/**
 * Decode `[]ObjectResponse` (`pkg/storage/objects.go:26-33`): `Id` is a `*string`,
 * so an absent or `null` id marks a directory (Go's `o.Id == nil`,
 * `internal/storage/ls/ls.go:67`); a present id (any non-null) marks a file. A
 * non-string non-null id fails the decode, matching Go's `*string` unmarshal.
 */
const decodeStorageObjects = (
  body: string,
): Effect.Effect<ReadonlyArray<LegacyStorageObject>, LegacyStorageGatewayNetworkError> =>
  Effect.gen(function* () {
    const parsed = yield* parseJsonBody(body);
    if (parsed === null) return [];
    if (!Array.isArray(parsed)) {
      return yield* Effect.fail(failParse("expected an array of objects"));
    }
    const result: Array<LegacyStorageObject> = [];
    for (const entry of parsed) {
      const obj = asObject(entry);
      if (obj === null) {
        return yield* Effect.fail(failParse("invalid object entry"));
      }
      const name = decodeStringField(obj, "name");
      if (name === null) {
        return yield* Effect.fail(failParse("invalid object entry"));
      }
      const idValue = obj["id"];
      if (idValue !== undefined && idValue !== null && typeof idValue !== "string") {
        return yield* Effect.fail(failParse("invalid object entry"));
      }
      result.push({ name, isDir: idValue === undefined || idValue === null });
    }
    return result;
  });

const decodeVectorBucketNames = (
  body: string,
): Effect.Effect<ReadonlyArray<string>, LegacyStorageGatewayNetworkError> =>
  Effect.gen(function* () {
    const parsed = yield* parseJsonBody(body);
    const root = asObject(parsed);
    if (root === null) {
      return yield* Effect.fail(failParse("expected a vector bucket list object"));
    }
    const list = root["vectorBuckets"];
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
 * Validate a `{<field>}` success body and return the field's value. Go's
 * mutations decode the 200 body via `fetcher.ParseJSON` into `{name}`/`{message}`
 * and fail on a non-JSON/empty body. `null` is tolerated (Go's zero value); a
 * non-object top-level or a wrong-typed field fails.
 */
const decodeFieldResponse = (
  body: string,
  field: string,
): Effect.Effect<string, LegacyStorageGatewayNetworkError> =>
  Effect.gen(function* () {
    const parsed = yield* parseJsonBody(body);
    if (parsed === null) return "";
    const obj = asObject(parsed);
    const value = obj === null ? null : decodeStringField(obj, field);
    if (value === null) {
      return yield* Effect.fail(failParse(`invalid ${field} response`));
    }
    return value;
  });

const decodeDeleteObjects = (
  body: string,
): Effect.Effect<ReadonlyArray<{ readonly name: string }>, LegacyStorageGatewayNetworkError> =>
  Effect.gen(function* () {
    const parsed = yield* parseJsonBody(body);
    if (parsed === null) return [];
    if (!Array.isArray(parsed)) {
      return yield* Effect.fail(failParse("expected an array of deleted objects"));
    }
    const result: Array<{ name: string }> = [];
    for (const entry of parsed) {
      const obj = asObject(entry);
      const name = obj === null ? null : decodeStringField(obj, "name");
      if (name === null) {
        return yield* Effect.fail(failParse("invalid deleted object entry"));
      }
      result.push({ name });
    }
    return result;
  });

const decodeAnalyticsBucketNames = (
  body: string,
): Effect.Effect<ReadonlyArray<string>, LegacyStorageGatewayNetworkError> =>
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

  const hintPort = localGatewayHintPort(opts.baseUrl);

  const networkError = (cause: unknown): LegacyStorageGatewayNetworkError => {
    const base = `failed to execute http request: ${cause}`;
    if (
      hintPort !== undefined &&
      HttpClientError.isHttpClientError(cause) &&
      cause.reason._tag === "TransportError" &&
      !isConnectionRefused(cause.reason)
    ) {
      return new LegacyStorageGatewayNetworkError({
        message: `${base}\n\n${legacyLocalGatewayHint(hintPort)}`,
      });
    }
    return new LegacyStorageGatewayNetworkError({ message: base });
  };

  // Go's `withAuthToken` (`pkg/fetcher/gateway.go:22`) gates the bearer header on
  // a plain `sb_` prefix check: opaque `sb_...` keys are not JWTs.
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

  // Sends a request and returns the response body text, reproducing Go's
  // fetcher error shapes (`pkg/fetcher/http.go`). Go's service gateway installs
  // `WithExpectedStatus(http.StatusOK)`, so only exactly 200 is a success.
  const send = Effect.fnUntraced(function* (req: HttpClientRequest.HttpClientRequest) {
    const { status, body } = yield* Effect.gen(function* () {
      const response = yield* httpClient.execute(req);
      const text = yield* response.text;
      return { status: response.status, body: text };
    }).pipe(Effect.mapError(networkError));
    if (status !== 200) {
      return yield* Effect.fail(
        new LegacyStorageGatewayStatusError({
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
      ).pipe(
        Effect.flatMap((body) => decodeFieldResponse(body, "name")),
        Effect.asVoid,
      ),
    updateBucket: (id, props) =>
      send(
        withAuth(HttpClientRequest.put(url(`/storage/v1/bucket/${id}`))).pipe(
          HttpClientRequest.bodyJsonUnsafe(legacyBucketBody(props)),
        ),
      ).pipe(
        Effect.flatMap((body) => decodeFieldResponse(body, "message")),
        Effect.asVoid,
      ),
    deleteBucket: (id) =>
      send(withAuth(HttpClientRequest.make("DELETE")(url(`/storage/v1/bucket/${id}`)))).pipe(
        Effect.flatMap((body) => decodeFieldResponse(body, "message")),
      ),
    listObjects: (bucket, prefix, page) => {
      const [dir, name] = legacyGoPathSplit(prefix);
      const query: Record<string, unknown> = { prefix: dir };
      if (name.length > 0) query["search"] = name;
      query["limit"] = LEGACY_PAGE_LIMIT;
      if (page > 0) query["offset"] = LEGACY_PAGE_LIMIT * page;
      return send(
        withAuth(HttpClientRequest.post(url(`/storage/v1/object/list/${bucket}`))).pipe(
          HttpClientRequest.bodyJsonUnsafe(query),
        ),
      ).pipe(Effect.flatMap(decodeStorageObjects));
    },
    downloadObject: (remotePath) => {
      const trimmed = remotePath.startsWith("/") ? remotePath.slice(1) : remotePath;
      const req = withAuth(HttpClientRequest.get(url(`/storage/v1/object/${trimmed}`)));
      return HttpClientResponse.stream(
        httpClient.execute(req).pipe(
          Effect.mapError(networkError),
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.succeed(response)
              : response.text.pipe(
                  Effect.mapError(networkError),
                  Effect.flatMap((body) =>
                    Effect.fail(
                      new LegacyStorageGatewayStatusError({
                        status: response.status,
                        body,
                        message: `Error status ${response.status}: ${body}`,
                      }),
                    ),
                  ),
                ),
          ),
        ),
      ).pipe(
        Stream.mapError((cause) =>
          cause instanceof LegacyStorageGatewayNetworkError ||
          cause instanceof LegacyStorageGatewayStatusError
            ? cause
            : networkError(cause),
        ),
      );
    },
    uploadObject: (remotePath, absPath, options) => {
      const trimmed = remotePath.startsWith("/") ? remotePath.slice(1) : remotePath;
      let req = withAuth(HttpClientRequest.post(url(`/storage/v1/object/${trimmed}`)));
      if (options.cacheControl.length > 0) {
        req = req.pipe(HttpClientRequest.setHeader("Cache-Control", options.cacheControl));
      }
      if (options.overwrite) {
        req = req.pipe(HttpClientRequest.setHeader("x-upsert", "true"));
      }
      // `bodyFile` stats the file for Content-Length and streams it via
      // FileSystem rather than buffering — the analogue of Go's open-and-stream
      // upload. The captured FileSystem is supplied here so the gateway's public
      // Effect type stays free of a service requirement.
      const withBody =
        options.contentType.length > 0
          ? HttpClientRequest.bodyFile(req, absPath, { contentType: options.contentType })
          : HttpClientRequest.bodyFile(req, absPath);
      return withBody.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError(
          (cause) =>
            new LegacyStorageGatewayNetworkError({
              message: `failed to execute http request: ${cause}`,
            }),
        ),
        Effect.flatMap(send),
        Effect.asVoid,
      );
    },
    moveObject: (bucketId, srcKey, dstKey) =>
      send(
        withAuth(HttpClientRequest.post(url("/storage/v1/object/move"))).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            bucketId,
            sourceKey: srcKey,
            destinationKey: dstKey,
          }),
        ),
      ).pipe(Effect.flatMap((body) => decodeFieldResponse(body, "message"))),
    deleteObjects: (bucket, prefixes) =>
      send(
        withAuth(HttpClientRequest.make("DELETE")(url(`/storage/v1/object/${bucket}`))).pipe(
          HttpClientRequest.bodyJsonUnsafe({ prefixes }),
        ),
      ).pipe(Effect.flatMap(decodeDeleteObjects)),
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
  };

  return gateway;
});
