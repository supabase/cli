import { describe, expect, it } from "@effect/vitest";

import {
  legacyIsLocalVectorBucketsUnavailable,
  legacyIsVectorBucketsFeatureNotEnabled,
} from "./buckets.classify.ts";

describe("legacyIsVectorBucketsFeatureNotEnabled", () => {
  it("matches when the message mentions FeatureNotEnabled", () => {
    expect(
      legacyIsVectorBucketsFeatureNotEnabled('Error status 400: {"code":"FeatureNotEnabled"}'),
    ).toBe(true);
  });

  it("does not match an unrelated error", () => {
    expect(legacyIsVectorBucketsFeatureNotEnabled("Error status 500: boom")).toBe(false);
  });
});

describe("legacyIsLocalVectorBucketsUnavailable", () => {
  it("matches the 'Vector service not configured' message", () => {
    expect(
      legacyIsLocalVectorBucketsUnavailable(
        "Error status 409: The feature Vector service not configured is not enabled",
      ),
    ).toBe(true);
  });

  it("matches a 404 on the ListVectorBuckets route", () => {
    expect(
      legacyIsLocalVectorBucketsUnavailable(
        "Error status 404: Route POST:/vector/ListVectorBuckets not found",
      ),
    ).toBe(true);
  });

  it("does not match a 404 on a different route", () => {
    expect(
      legacyIsLocalVectorBucketsUnavailable("Error status 404: Route POST:/something not found"),
    ).toBe(false);
  });

  it("does not match an unrelated error", () => {
    expect(legacyIsLocalVectorBucketsUnavailable("Error status 500: boom")).toBe(false);
  });
});
