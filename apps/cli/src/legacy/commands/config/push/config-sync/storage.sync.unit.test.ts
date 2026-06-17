import { describe, expect, it } from "vitest";

import {
  diffStorageWithRemote,
  storageToUpdateBody,
  type RemoteStorageConfig,
  type StorageSubset,
} from "./storage.sync.ts";

const lines = (...l: Array<string>) => l.join("\n") + "\n";

const emptyCounts = {
  analytics: {
    enabled: false,
    max_namespaces: 0,
    max_tables: 0,
    max_catalogs: 0,
    buckets: [] as Array<string>,
  },
  vector: {
    enabled: false,
    max_buckets: 0,
    max_indexes: 0,
    buckets: [] as Array<string>,
  },
} as const;

function remote(overrides: Partial<RemoteStorageConfig> = {}): RemoteStorageConfig {
  return {
    fileSizeLimit: 52428800,
    features: {
      imageTransformation: { enabled: false },
      s3Protocol: { enabled: false },
      icebergCatalog: { enabled: false, maxNamespaces: 0, maxTables: 0, maxCatalogs: 0 },
      vectorBuckets: { enabled: false, maxBuckets: 0, maxIndexes: 0 },
    },
    ...overrides,
  };
}

/**
 * Golden parity captured from Go `(*storage).DiffWithRemote`. Exercises the
 * `BytesSize` quoting of `file_size_limit`, the depth-1 blank line before
 * top-level tables, the `[analytics.buckets]` empty-map header, and the
 * image_transformation / s3 / analytics feature mapping.
 */
describe("diffStorageWithRemote", () => {
  it("diffs file size and image transformation", () => {
    const local: StorageSubset = {
      enabled: true,
      file_size_limit: 52428800,
      image_transformation: { enabled: true },
      s3_protocol: { enabled: true },
      buckets: {},
      ...emptyCounts,
    };
    expect(
      diffStorageWithRemote(
        local,
        remote({
          fileSizeLimit: 104857600,
          features: {
            imageTransformation: { enabled: false },
            s3Protocol: { enabled: true },
            icebergCatalog: { enabled: false, maxNamespaces: 0, maxTables: 0, maxCatalogs: 0 },
            vectorBuckets: { enabled: false, maxBuckets: 0, maxIndexes: 0 },
          },
        }),
      ),
    ).toBe(
      lines(
        "diff remote[storage] local[storage]",
        "--- remote[storage]",
        "+++ local[storage]",
        "@@ -1,8 +1,8 @@",
        " enabled = true",
        '-file_size_limit = "100MiB"',
        '+file_size_limit = "50MiB"',
        " ",
        " [image_transformation]",
        "-enabled = false",
        "+enabled = true",
        " ",
        " [s3_protocol]",
        " enabled = true",
      ),
    );
  });

  it("produces no diff when only an unchanged bucket is present", () => {
    const local: StorageSubset = {
      enabled: true,
      file_size_limit: 52428800,
      image_transformation: undefined,
      s3_protocol: undefined,
      buckets: {
        avatars: {
          public: true,
          file_size_limit: 5242880,
          allowed_mime_types: ["image/png"],
          objects_path: "./avatars",
        },
      },
      ...emptyCounts,
    };
    expect(diffStorageWithRemote(local, remote())).toBe("");
  });

  it("diffs analytics bucket counts and emits the empty buckets table", () => {
    const local: StorageSubset = {
      enabled: true,
      file_size_limit: 52428800,
      image_transformation: undefined,
      s3_protocol: undefined,
      buckets: {},
      analytics: {
        enabled: true,
        max_namespaces: 5,
        max_tables: 10,
        max_catalogs: 2,
        buckets: [],
      },
      vector: emptyCounts.vector,
    };
    expect(
      diffStorageWithRemote(
        local,
        remote({
          features: {
            imageTransformation: { enabled: false },
            s3Protocol: { enabled: false },
            icebergCatalog: { enabled: true, maxNamespaces: 10, maxTables: 20, maxCatalogs: 3 },
            vectorBuckets: { enabled: false, maxBuckets: 0, maxIndexes: 0 },
          },
        }),
      ),
    ).toBe(
      lines(
        "diff remote[storage] local[storage]",
        "--- remote[storage]",
        "+++ local[storage]",
        "@@ -5,9 +5,9 @@",
        " ",
        " [analytics]",
        " enabled = true",
        "-max_namespaces = 10",
        "-max_tables = 20",
        "-max_catalogs = 3",
        "+max_namespaces = 5",
        "+max_tables = 10",
        "+max_catalogs = 2",
        " [analytics.buckets]",
        " ",
        " [vector]",
      ),
    );
  });
});

describe("storageToUpdateBody", () => {
  it("maps features for enabled sub-services", () => {
    const local: StorageSubset = {
      enabled: true,
      file_size_limit: 52428800,
      image_transformation: { enabled: true },
      s3_protocol: { enabled: false },
      buckets: undefined,
      analytics: { enabled: true, max_namespaces: 5, max_tables: 10, max_catalogs: 2, buckets: [] },
      vector: { enabled: true, max_buckets: 7, max_indexes: 3, buckets: [] },
    };
    expect(storageToUpdateBody(local)).toEqual({
      fileSizeLimit: 52428800,
      features: {
        imageTransformation: { enabled: true },
        icebergCatalog: { enabled: true, maxNamespaces: 5, maxTables: 10, maxCatalogs: 2 },
        vectorBuckets: { enabled: true, maxBuckets: 7, maxIndexes: 3 },
        s3Protocol: { enabled: false },
      },
    });
  });

  it("omits features for disabled / unset sub-services", () => {
    const local: StorageSubset = {
      enabled: true,
      file_size_limit: 100,
      image_transformation: undefined,
      s3_protocol: undefined,
      buckets: undefined,
      analytics: { enabled: false, max_namespaces: 0, max_tables: 0, max_catalogs: 0, buckets: [] },
      vector: { enabled: false, max_buckets: 0, max_indexes: 0, buckets: [] },
    };
    expect(storageToUpdateBody(local)).toEqual({ fileSizeLimit: 100, features: {} });
  });
});
