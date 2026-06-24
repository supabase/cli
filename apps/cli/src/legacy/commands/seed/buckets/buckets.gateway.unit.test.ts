import { describe, expect, it } from "vitest";

import { legacyBucketBody } from "./buckets.gateway.ts";

describe("legacyBucketBody", () => {
  it("omits public when undefined (Go *bool nil / omitempty)", () => {
    expect(legacyBucketBody({ public: undefined, fileSizeLimit: 0, allowedMimeTypes: [] })).toEqual(
      {},
    );
  });

  it("includes public when explicitly set (true or false)", () => {
    expect(legacyBucketBody({ public: true, fileSizeLimit: 0, allowedMimeTypes: [] })).toEqual({
      public: true,
    });
    expect(legacyBucketBody({ public: false, fileSizeLimit: 0, allowedMimeTypes: [] })).toEqual({
      public: false,
    });
  });

  it("omits file_size_limit when 0 and allowed_mime_types when empty", () => {
    expect(
      legacyBucketBody({ public: undefined, fileSizeLimit: 0, allowedMimeTypes: [] }),
    ).not.toHaveProperty("file_size_limit");
  });

  it("includes file_size_limit and allowed_mime_types when present", () => {
    expect(
      legacyBucketBody({
        public: false,
        fileSizeLimit: 52_428_800,
        allowedMimeTypes: ["image/png"],
      }),
    ).toEqual({
      public: false,
      file_size_limit: 52_428_800,
      allowed_mime_types: ["image/png"],
    });
  });
});
