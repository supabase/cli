import { Effect, FileSystem, Stream } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { kongAuthHeaders } from "./kong-auth.ts";
import { StorageGatewayNetworkError, StorageGatewayStatusError } from "./storage-gateway.errors.ts";
import { goPathSplit } from "./storage-url.ts";

/**
 * Client for the Supabase Storage service gateway (Kong). See
 * {@link kongAuthHeaders} for the auth header shape.
 *
 * Shared by `seed buckets` (bucket/object/vector upsert) and `storage
 * ls/cp/mv/rm` (object list/download/move/delete + bucket delete).
 */

export const PAGE_LIMIT = 100;
export const DELETE_OBJECTS_LIMIT = 1000;

interface BucketSummary {
  readonly name: string;
  readonly id: string;
}

/** A `/storage/v1/object/list/{bucket}` entry: a directory when `id` is absent. */
interface StorageObject {
  readonly name: string;
  readonly isDir: boolean;
}

export interface UpsertBucketProps {
  /** `undefined` when `public` is absent from the bucket's TOML config; otherwise the explicit value. */
  readonly public: boolean | undefined;
  /** Byte count; omitted from the request body when 0. */
  readonly fileSizeLimit: number;
  readonly allowedMimeTypes: ReadonlyArray<string>;
}

interface UploadObjectOptions {
  readonly contentType: string;
  readonly cacheControl: string;
  readonly overwrite: boolean;
}

export interface StorageGateway {
  readonly listBuckets: () => Effect.Effect<
    ReadonlyArray<BucketSummary>,
    StorageGatewayNetworkError | StorageGatewayStatusError
  >;
  readonly createBucket: (
    name: string,
    props: UpsertBucketProps,
  ) => Effect.Effect<void, StorageGatewayNetworkError | StorageGatewayStatusError>;
  readonly updateBucket: (
    id: string,
    props: UpsertBucketProps,
  ) => Effect.Effect<void, StorageGatewayNetworkError | StorageGatewayStatusError>;
  readonly deleteBucket: (
    id: string,
  ) => Effect.Effect<string, StorageGatewayNetworkError | StorageGatewayStatusError>;
  readonly listObjects: (
    bucket: string,
    prefix: string,
    page: number,
  ) => Effect.Effect<
    ReadonlyArray<StorageObject>,
    StorageGatewayNetworkError | StorageGatewayStatusError
  >;
  /** Streams the object body; fails before the first byte on a non-200 status. */
  readonly downloadObject: (
    remotePath: string,
  ) => Stream.Stream<Uint8Array, StorageGatewayNetworkError | StorageGatewayStatusError>;
  readonly uploadObject: (
    remotePath: string,
    absPath: string,
    options: UploadObjectOptions,
  ) => Effect.Effect<void, StorageGatewayNetworkError | StorageGatewayStatusError>;
  readonly moveObject: (
    bucketId: string,
    srcKey: string,
    dstKey: string,
  ) => Effect.Effect<string, StorageGatewayNetworkError | StorageGatewayStatusError>;
  readonly deleteObjects: (
    bucket: string,
    prefixes: ReadonlyArray<string>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly name: string }>,
    StorageGatewayNetworkError | StorageGatewayStatusError
  >;
  readonly listVectorBuckets: () => Effect.Effect<
    ReadonlyArray<string>,
    StorageGatewayNetworkError | StorageGatewayStatusError
  >;
  readonly createVectorBucket: (
    name: string,
  ) => Effect.Effect<void, StorageGatewayNetworkError | StorageGatewayStatusError>;
  readonly deleteVectorBucket: (
    name: string,
  ) => Effect.Effect<void, StorageGatewayNetworkError | StorageGatewayStatusError>;
  readonly listAnalyticsBuckets: () => Effect.Effect<
    ReadonlyArray<string>,
    StorageGatewayNetworkError | StorageGatewayStatusError
  >;
  readonly createAnalyticsBucket: (
    name: string,
  ) => Effect.Effect<void, StorageGatewayNetworkError | StorageGatewayStatusError>;
  readonly deleteAnalyticsBucket: (
    name: string,
  ) => Effect.Effect<void, StorageGatewayNetworkError | StorageGatewayStatusError>;
}

/**
 * Decode errors from below share this permissive-but-strict policy: missing
 * fields, `null`, empty arrays, and extra keys are tolerated; a non-matching
 * top-level type or a wrong-typed field fails the decode.
 */
function failParse(detail: string): StorageGatewayNetworkError {
  return new StorageGatewayNetworkError({
    message: `failed to parse response body: ${detail}`,
    decode: true,
  });
}

/**
 * Returns the port for `localGatewayHint`'s port-conflict message: only for a
 * loopback host, and using the resolved URL's port rather than `api.port`
 * (which can differ when `api.external_url` is set).
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

function localGatewayHint(port: string): string {
  return (
    "The local Supabase API gateway did not return a valid HTTP response. " +
    `Another process may be listening on the configured API port ${port}. ` +
    `Check the port with \`lsof -nP -iTCP:${port} -sTCP:LISTEN\`, then stop the conflicting process or set a different \`api.port\` in supabase/config.toml.`
  );
}

/**
 * Whether a transport failure is a plain connection-refused. The
 * port-conflict hint is suppressed for these, since a refused connection
 * means nothing is listening, not a malformed response.
 */
function isConnectionRefused(error: HttpClientError.TransportError): boolean {
  const detail =
    `${error.description ?? ""} ${String(error.cause ?? "")} ${error.message}`.toLowerCase();
  return /econnrefused|connection ?refused|unable to connect/.test(detail);
}

const parseJsonBody = (body: string): Effect.Effect<unknown, StorageGatewayNetworkError> =>
  Effect.try({
    try: () => JSON.parse(body) as unknown,
    catch: (cause) => failParse(String(cause)),
  });

/** A JSON object → itself; `null` → `{}`; anything else → `null`. */
function asObject(entry: unknown): Record<string, unknown> | null {
  if (entry === null) return {};
  return typeof entry === "object" && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)
    : null;
}

/** A string field: absent or `null` decodes as `""`; a wrong type fails the decode (returns `null`). */
function decodeStringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : null;
}

const decodeBucketSummaries = (
  body: string,
): Effect.Effect<ReadonlyArray<BucketSummary>, StorageGatewayNetworkError> =>
  Effect.gen(function* () {
    const parsed = yield* parseJsonBody(body);
    if (parsed === null) return [];
    if (!Array.isArray(parsed)) {
      return yield* Effect.fail(failParse("expected an array of buckets"));
    }
    const result: Array<BucketSummary> = [];
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
 * Decodes a storage object list entry: an absent or `null` `id` marks a
 * directory; any other non-string value fails the decode.
 */
const decodeStorageObjects = (
  body: string,
): Effect.Effect<ReadonlyArray<StorageObject>, StorageGatewayNetworkError> =>
  Effect.gen(function* () {
    const parsed = yield* parseJsonBody(body);
    if (parsed === null) return [];
    if (!Array.isArray(parsed)) {
      return yield* Effect.fail(failParse("expected an array of objects"));
    }
    const result: Array<StorageObject> = [];
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
): Effect.Effect<ReadonlyArray<string>, StorageGatewayNetworkError> =>
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
 * Validates a `{<field>}` success body and returns the field's value. `null`
 * decodes as an empty result; a non-object top-level or a wrong-typed field
 * fails.
 */
const decodeFieldResponse = (
  body: string,
  field: string,
): Effect.Effect<string, StorageGatewayNetworkError> =>
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
): Effect.Effect<ReadonlyArray<{ readonly name: string }>, StorageGatewayNetworkError> =>
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
): Effect.Effect<ReadonlyArray<string>, StorageGatewayNetworkError> =>
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
 * Builds the create/update bucket request body: `public` is omitted when
 * absent from the TOML config, `file_size_limit` when 0, and
 * `allowed_mime_types` when empty.
 */
export function bucketBody(props: UpsertBucketProps): Record<string, unknown> {
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

export const makeStorageGateway = Effect.fnUntraced(function* (opts: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly userAgent: string;
}) {
  const httpClient = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;

  const hintPort = localGatewayHintPort(opts.baseUrl);

  const networkError = (cause: unknown): StorageGatewayNetworkError => {
    const base = `failed to execute http request: ${cause}`;
    if (
      hintPort !== undefined &&
      HttpClientError.isHttpClientError(cause) &&
      cause.reason._tag === "TransportError" &&
      !isConnectionRefused(cause.reason)
    ) {
      return new StorageGatewayNetworkError({
        message: `${base}\n\n${localGatewayHint(hintPort)}`,
      });
    }
    return new StorageGatewayNetworkError({ message: base });
  };

  const withAuth = (
    req: HttpClientRequest.HttpClientRequest,
  ): HttpClientRequest.HttpClientRequest =>
    req.pipe(
      HttpClientRequest.setHeader("User-Agent", opts.userAgent),
      HttpClientRequest.setHeaders(kongAuthHeaders(opts.apiKey)),
    );

  // Sends a request and returns the response body text; only exactly 200 counts as success.
  const send = Effect.fnUntraced(function* (req: HttpClientRequest.HttpClientRequest) {
    const { status, body } = yield* Effect.gen(function* () {
      const response = yield* httpClient.execute(req);
      const text = yield* response.text;
      return { status: response.status, body: text };
    }).pipe(Effect.mapError(networkError));
    if (status !== 200) {
      return yield* Effect.fail(
        new StorageGatewayStatusError({
          status,
          body,
          message: `Error status ${status}: ${body}`,
        }),
      );
    }
    return body;
  });

  const url = (path: string) => `${opts.baseUrl}${path}`;

  const gateway: StorageGateway = {
    listBuckets: () =>
      send(withAuth(HttpClientRequest.get(url("/storage/v1/bucket")))).pipe(
        Effect.flatMap(decodeBucketSummaries),
      ),
    createBucket: (name, props) =>
      send(
        withAuth(HttpClientRequest.post(url("/storage/v1/bucket"))).pipe(
          HttpClientRequest.bodyJsonUnsafe({ name, ...bucketBody(props) }),
        ),
      ).pipe(
        Effect.flatMap((body) => decodeFieldResponse(body, "name")),
        Effect.asVoid,
      ),
    updateBucket: (id, props) =>
      send(
        withAuth(HttpClientRequest.put(url(`/storage/v1/bucket/${id}`))).pipe(
          HttpClientRequest.bodyJsonUnsafe(bucketBody(props)),
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
      const [dir, name] = goPathSplit(prefix);
      const query: Record<string, unknown> = { prefix: dir };
      if (name.length > 0) query["search"] = name;
      query["limit"] = PAGE_LIMIT;
      if (page > 0) query["offset"] = PAGE_LIMIT * page;
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
                      new StorageGatewayStatusError({
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
          cause instanceof StorageGatewayNetworkError || cause instanceof StorageGatewayStatusError
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
      // `bodyFile` streams the file without buffering. FileSystem is provided
      // here (not via the Effect type) so the gateway's public Effect stays
      // free of a service requirement.
      const withBody =
        options.contentType.length > 0
          ? HttpClientRequest.bodyFile(req, absPath, { contentType: options.contentType })
          : HttpClientRequest.bodyFile(req, absPath);
      return withBody.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError(
          (cause) =>
            new StorageGatewayNetworkError({
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
