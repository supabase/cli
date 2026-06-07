import { describe, expect, test } from "vitest";

import { assertOpenApiDocument, resolveOpenApiSpecUrl } from "./download-openapi.ts";

describe("download-openapi", () => {
  test("defaults to the production API spec URL", () => {
    expect(resolveOpenApiSpecUrl(undefined)).toBe("https://api.supabase.com/api/v1-json");
  });

  test("derives the spec URL from SUPABASE_API_URL", () => {
    expect(resolveOpenApiSpecUrl("https://api.supabase.green")).toBe(
      "https://api.supabase.green/api/v1-json",
    );
    expect(resolveOpenApiSpecUrl("https://api.supabase.green/")).toBe(
      "https://api.supabase.green/api/v1-json",
    );
  });

  test("accepts an OpenAPI-like document with paths", () => {
    expect(() => assertOpenApiDocument({ paths: {} })).not.toThrow();
  });

  test("rejects documents without a paths object", () => {
    expect(() => assertOpenApiDocument({})).toThrow(
      "Downloaded spec is not a valid OpenAPI document with a paths object.",
    );
  });
});
