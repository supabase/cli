import { Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacySeedStorageNetworkError, LegacySeedStorageStatusError } from "./buckets.errors.ts";

/**
 * Native TypeScript client for the Supabase Storage **service gateway** (Kong),
 * mirroring `apps/cli-go/pkg/storage/{buckets,objects,vector}.go` and the
 * `fetcher.NewServiceGateway` auth headers (`apikey` + `Authorization: Bearer`).
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
    bytes: Uint8Array,
    contentType: string,
  ) => Effect.Effect<void, LegacySeedStorageNetworkError | LegacySeedStorageStatusError>;
}

function readString(obj: unknown, key: string): string {
  if (typeof obj === "object" && obj !== null && key in obj) {
    const value = (obj as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}

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

export const makeLegacyStorageGateway = Effect.fnUntraced(function* (opts: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly userAgent: string;
}) {
  const httpClient = yield* HttpClient.HttpClient;

  const withAuth = (
    req: HttpClientRequest.HttpClientRequest,
  ): HttpClientRequest.HttpClientRequest =>
    req.pipe(
      HttpClientRequest.setHeader("apikey", opts.apiKey),
      HttpClientRequest.setHeader("Authorization", `Bearer ${opts.apiKey}`),
      HttpClientRequest.setHeader("User-Agent", opts.userAgent),
    );

  // Sends a request and returns the response body text, reproducing the Go
  // fetcher's error shapes (`pkg/fetcher/http.go`): transport failure →
  // network error; non-2xx → `Error status <d>: <body>` status error.
  const send = Effect.fnUntraced(function* (req: HttpClientRequest.HttpClientRequest) {
    const { status, body } = yield* Effect.gen(function* () {
      const response = yield* httpClient.execute(req);
      const text = yield* response.text;
      return { status: response.status, body: text };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new LegacySeedStorageNetworkError({
            message: `failed to execute http request: ${cause}`,
          }),
      ),
    );
    if (status < 200 || status >= 300) {
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
        Effect.map((body) => {
          const parsed: unknown = JSON.parse(body);
          if (!Array.isArray(parsed)) return [];
          return parsed.map((entry) => ({
            name: readString(entry, "name"),
            id: readString(entry, "id"),
          }));
        }),
      ),
    createBucket: (name, props) =>
      send(
        withAuth(HttpClientRequest.post(url("/storage/v1/bucket"))).pipe(
          HttpClientRequest.bodyJsonUnsafe({ name, ...legacyBucketBody(props) }),
        ),
      ).pipe(Effect.asVoid),
    updateBucket: (id, props) =>
      send(
        withAuth(HttpClientRequest.put(url(`/storage/v1/bucket/${id}`))).pipe(
          HttpClientRequest.bodyJsonUnsafe(legacyBucketBody(props)),
        ),
      ).pipe(Effect.asVoid),
    listVectorBuckets: () =>
      send(
        withAuth(HttpClientRequest.post(url("/storage/v1/vector/ListVectorBuckets"))).pipe(
          HttpClientRequest.bodyJsonUnsafe({}),
        ),
      ).pipe(
        Effect.map((body) => {
          const parsed: unknown = JSON.parse(body);
          const list =
            typeof parsed === "object" && parsed !== null
              ? (parsed as { vectorBuckets?: unknown }).vectorBuckets
              : undefined;
          if (!Array.isArray(list)) return [];
          return list.map((entry) => readString(entry, "vectorBucketName"));
        }),
      ),
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
    uploadObject: (remotePath, bytes, contentType) => {
      const trimmed = remotePath.startsWith("/") ? remotePath.slice(1) : remotePath;
      const req = withAuth(HttpClientRequest.post(url(`/storage/v1/object/${trimmed}`))).pipe(
        HttpClientRequest.setHeader("Cache-Control", "max-age=3600"),
        HttpClientRequest.setHeader("x-upsert", "true"),
      );
      return send(HttpClientRequest.bodyUint8Array(req, bytes, contentType)).pipe(Effect.asVoid);
    },
  };

  return gateway;
});
