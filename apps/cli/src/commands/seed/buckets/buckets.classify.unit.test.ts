import { describe, expect, it } from "@effect/vitest";

import {
  isLocalVectorBucketsUnavailable,
  isVectorBucketsFeatureNotEnabled,
} from "./buckets.classify.ts";

describe("isVectorBucketsFeatureNotEnabled", () => {
  it("matches when the message mentions FeatureNotEnabled", () => {
    expect(isVectorBucketsFeatureNotEnabled('Error status 400: {"code":"FeatureNotEnabled"}')).toBe(
      true,
    );
  });

  it("does not match an unrelated error", () => {
    expect(isVectorBucketsFeatureNotEnabled("Error status 500: boom")).toBe(false);
  });
});

describe("isLocalVectorBucketsUnavailable", () => {
  it("matches the 'Vector service not configured' message", () => {
    expect(
      isLocalVectorBucketsUnavailable(
        "Error status 409: The feature Vector service not configured is not enabled",
      ),
    ).toBe(true);
  });

  it("matches a 404 on the ListVectorBuckets route", () => {
    expect(
      isLocalVectorBucketsUnavailable(
        "Error status 404: Route POST:/vector/ListVectorBuckets not found",
      ),
    ).toBe(true);
  });

  it("does not match a 404 on a different route", () => {
    expect(
      isLocalVectorBucketsUnavailable("Error status 404: Route POST:/something not found"),
    ).toBe(false);
  });

  it("does not match an unrelated error", () => {
    expect(isLocalVectorBucketsUnavailable("Error status 500: boom")).toBe(false);
  });
});
