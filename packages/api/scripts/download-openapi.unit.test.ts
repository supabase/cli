import { describe, expect, test, vi } from "vitest";

import {
  applyOpenApiOverrides,
  assertMergedOpenApiDocument,
  assertOpenApiDocument,
  mergeOpenApiDocuments,
  resolveOpenApiBaseUrl,
  resolveOpenApiSpecUrl,
  resolveOpenApiSpecUrls,
} from "./download-openapi.ts";

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

  test("applies OpenAPI JSON Patch overrides", () => {
    const samlProperties: Record<string, unknown> = {};
    const document = {
      paths: {},
      components: {
        schemas: {
          ListProvidersResponse: {
            properties: {
              items: {
                items: {
                  properties: {
                    saml: {
                      required: ["id", "entity_id"],
                      properties: samlProperties,
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    applyOpenApiOverrides(document, [
      {
        op: "test",
        path: "/components/schemas/ListProvidersResponse/properties/items/items/properties/saml/required",
        value: ["id", "entity_id"],
      },
      {
        op: "replace",
        path: "/components/schemas/ListProvidersResponse/properties/items/items/properties/saml/required",
        value: ["entity_id"],
      },
      {
        op: "add",
        path: "/components/schemas/ListProvidersResponse/properties/items/items/properties/saml/properties/high_availability",
        value: { type: "boolean" },
      },
    ]);

    const saml =
      document.components.schemas.ListProvidersResponse.properties.items.items.properties.saml;
    expect(saml.required).toEqual(["entity_id"]);
    expect(samlProperties.high_availability).toEqual({ type: "boolean" });
  });

  test("fails when an OpenAPI override test no longer matches", () => {
    expect(() =>
      applyOpenApiOverrides(
        { paths: {}, components: { schemas: { ListProvidersResponse: { required: [] } } } },
        [
          {
            op: "test",
            path: "/components/schemas/ListProvidersResponse/required",
            value: ["items"],
          },
        ],
      ),
    ).toThrow("OpenAPI override test failed");
  });

  test("fails when an OpenAPI add override already exists", () => {
    expect(() =>
      applyOpenApiOverrides(
        { paths: {}, components: { schemas: { Body: { properties: { enabled: {} } } } } },
        [
          {
            op: "add",
            path: "/components/schemas/Body/properties/enabled",
            value: { type: "boolean" },
          },
        ],
      ),
    ).toThrow("cannot be added");
  });

  test("derives the v2 spec URL and still normalizes a trailing slash", () => {
    expect(resolveOpenApiSpecUrl("https://api.supabase.com", "v2")).toBe(
      "https://api.supabase.com/api/v2-json",
    );
    expect(resolveOpenApiSpecUrl("https://api.supabase.com/", "v2")).toBe(
      "https://api.supabase.com/api/v2-json",
    );
  });

  test("resolves both the v1 and v2 spec URLs for a single base URL", () => {
    expect(resolveOpenApiSpecUrls("https://api.supabase.com")).toEqual([
      { version: "v1", url: "https://api.supabase.com/api/v1-json" },
      { version: "v2", url: "https://api.supabase.com/api/v2-json" },
    ]);
  });

  test("resolves the base URL with env > pinned > default precedence", () => {
    expect(
      resolveOpenApiBaseUrl({
        envBaseUrl: "https://env.supabase.com",
        pinnedBaseUrl: "https://pinned.supabase.com",
      }),
    ).toBe("https://env.supabase.com");
    expect(resolveOpenApiBaseUrl({ pinnedBaseUrl: "https://pinned.supabase.com" })).toBe(
      "https://pinned.supabase.com",
    );
    expect(resolveOpenApiBaseUrl({})).toBe("https://api.supabase.com");
  });

  test("merging a single document is an identity for its paths and schemas", () => {
    const document = {
      openapi: "3.0.0",
      info: { title: "Some Title", version: "1.0.0" },
      paths: { "/v1/a": { get: {} } },
      components: { schemas: { Foo: { type: "string" } } },
    };

    const merged = mergeOpenApiDocuments([{ version: "v1", document }]);

    expect(merged.paths).toEqual(document.paths);
    expect(merged.components?.schemas).toEqual(document.components.schemas);
  });

  test("merges v1 and v2 documents, ordering v1 paths before v2 and unioning their schemas", () => {
    const v1Document = {
      openapi: "3.0.0",
      info: { title: "V1 Title", version: "1.0.0" },
      paths: { "/v1/a": { get: {} }, "/v1/b": { get: {} } },
      components: { schemas: { Foo: { type: "string" } } },
    };
    const v2Document = {
      openapi: "3.0.0",
      info: { title: "V2 Title", version: "1.0.0" },
      paths: { "/v2/c": { get: {} } },
      components: { schemas: { Bar: { type: "number" } } },
    };

    const merged = mergeOpenApiDocuments([
      { version: "v1", document: v1Document },
      { version: "v2", document: v2Document },
    ]);

    expect(Object.keys(merged.paths)).toEqual(["/v1/a", "/v1/b", "/v2/c"]);
    expect(merged.components?.schemas).toEqual({
      Foo: { type: "string" },
      Bar: { type: "number" },
    });
    expect(merged.info).toEqual({ title: "Supabase API", version: "1.0.0" });
  });

  test('throws when the documents\' "openapi" versions disagree', () => {
    const v1Document = { openapi: "3.0.0", info: { version: "1.0.0" }, paths: { "/v1/a": {} } };
    const v2Document = { openapi: "3.1.0", info: { version: "1.0.0" }, paths: { "/v2/a": {} } };

    expect(() =>
      mergeOpenApiDocuments([
        { version: "v1", document: v1Document },
        { version: "v2", document: v2Document },
      ]),
    ).toThrow('OpenAPI "openapi" version mismatch between v1 (3.0.0) and v2 (3.1.0).');
  });

  test('throws when the documents\' "info.version" disagree', () => {
    const v1Document = { openapi: "3.0.0", info: { version: "1.0.0" }, paths: { "/v1/a": {} } };
    const v2Document = { openapi: "3.0.0", info: { version: "2.0.0" }, paths: { "/v2/a": {} } };

    expect(() =>
      mergeOpenApiDocuments([
        { version: "v1", document: v1Document },
        { version: "v2", document: v2Document },
      ]),
    ).toThrow('OpenAPI "info.version" mismatch between v1 (1.0.0) and v2 (2.0.0).');
  });

  test("throws when a v2 document contains a path outside the /v2/ namespace", () => {
    const v1Document = { openapi: "3.0.0", info: { version: "1.0.0" }, paths: { "/v1/a": {} } };
    const v2Document = { openapi: "3.0.0", info: { version: "1.0.0" }, paths: { "/v1/foo": {} } };

    expect(() =>
      mergeOpenApiDocuments([
        { version: "v1", document: v1Document },
        { version: "v2", document: v2Document },
      ]),
    ).toThrow('OpenAPI path "/v1/foo" in the v2 document does not start with "/v2/".');
  });

  test("throws when the same path key appears twice across documents", () => {
    // Can only happen when the same declared version is fetched/merged twice,
    // since a document's own version-prefix check would otherwise reject a
    // literal path belonging to a different version before this check runs.
    const firstDocument = {
      openapi: "3.0.0",
      info: { version: "1.0.0" },
      paths: { "/v1/a": { get: {} } },
    };
    const secondDocument = {
      openapi: "3.0.0",
      info: { version: "1.0.0" },
      paths: { "/v1/a": { post: {} } },
    };

    expect(() =>
      mergeOpenApiDocuments([
        { version: "v1", document: firstDocument },
        { version: "v1", document: secondDocument },
      ]),
    ).toThrow('Duplicate OpenAPI path "/v1/a" found in both the v1 and v1 documents.');
  });

  test("dedupes an identical duplicate schema found in both documents", () => {
    const v1Document = {
      openapi: "3.0.0",
      info: { version: "1.0.0" },
      paths: { "/v1/a": {} },
      components: { schemas: { Shared: { type: "string" } } },
    };
    const v2Document = {
      openapi: "3.0.0",
      info: { version: "1.0.0" },
      paths: { "/v2/a": {} },
      components: { schemas: { Shared: { type: "string" } } },
    };

    const merged = mergeOpenApiDocuments([
      { version: "v1", document: v1Document },
      { version: "v2", document: v2Document },
    ]);

    expect(merged.components?.schemas).toEqual({ Shared: { type: "string" } });
  });

  test("throws when two documents disagree on the same schema name", () => {
    const v1Document = {
      openapi: "3.0.0",
      info: { version: "1.0.0" },
      paths: { "/v1/a": {} },
      components: { schemas: { Shared: { type: "string" } } },
    };
    const v2Document = {
      openapi: "3.0.0",
      info: { version: "1.0.0" },
      paths: { "/v2/a": {} },
      components: { schemas: { Shared: { type: "number" } } },
    };

    expect(() =>
      mergeOpenApiDocuments([
        { version: "v1", document: v1Document },
        { version: "v2", document: v2Document },
      ]),
    ).toThrow('Conflicting OpenAPI schema "Shared" found in both the v1 and v2 documents.');
  });

  test("throws on duplicate operationId across the v2 webhook paths (CLI-2157 platform bug)", () => {
    const document = {
      paths: {
        "/v2/projects/{ref}/webhooks/endpoints": {
          get: { operationId: "allV2ProjectsByRefWebhooks" },
        },
        "/v2/projects/{ref}/webhooks/endpoints/{id}": {
          get: { operationId: "allV2ProjectsByRefWebhooks" },
        },
      },
    };

    expect(() => assertMergedOpenApiDocument(document)).toThrow(
      'Duplicate OpenAPI operationId "allV2ProjectsByRefWebhooks" claimed by: GET /v2/projects/{ref}/webhooks/endpoints, GET /v2/projects/{ref}/webhooks/endpoints/{id}.',
    );
  });

  test("throws when an operationId's version prefix disagrees with its path", () => {
    const document = { paths: { "/v2/x": { get: { operationId: "v1-x" } } } };

    expect(() => assertMergedOpenApiDocument(document)).toThrow(
      'OpenAPI operationId "v1-x" for GET /v2/x has version prefix "v1" that does not match the path\'s leading segment "v2".',
    );
  });

  test("warns instead of throwing when an operation has no operationId", () => {
    const document = { paths: { "/v1/a": { get: {} } } };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => assertMergedOpenApiDocument(document)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      "OpenAPI operation GET /v1/a has no operationId; generate.ts will skip it.",
    );

    warnSpy.mockRestore();
  });

  test("applyOpenApiOverrides tolerantly removes JSON pointers that no longer exist", () => {
    const withExistingPath = { paths: { "/v1/foo": { get: {} } } };
    applyOpenApiOverrides(withExistingPath, [{ op: "remove", path: "/paths/~1v1~1foo" }]);
    expect(withExistingPath.paths).toEqual({});

    const withMissingPath = { paths: {} };
    applyOpenApiOverrides(withMissingPath, [{ op: "remove", path: "/paths/~1v1~1missing" }]);
    expect(withMissingPath.paths).toEqual({});

    const withMissingIntermediateSegment = { paths: {} };
    applyOpenApiOverrides(withMissingIntermediateSegment, [
      { op: "remove", path: "/paths/~1nope/get" },
    ]);
    expect(withMissingIntermediateSegment.paths).toEqual({});

    const withArray = { paths: {}, components: { schemas: { Foo: { enum: ["a", "b", "c"] } } } };
    applyOpenApiOverrides(withArray, [{ op: "remove", path: "/components/schemas/Foo/enum/1" }]);
    expect(withArray.components.schemas.Foo.enum).toEqual(["a", "c"]);
  });

  test("rejects a remove override that carries a value", () => {
    expect(() =>
      applyOpenApiOverrides({ paths: {} }, [{ op: "remove", path: "/paths", value: {} }]),
    ).toThrow("OpenAPI remove overrides must not include a value.");
  });

  test("assertMergedOpenApiDocument passes after the webhook-collision remove overrides are applied but fails without them", () => {
    const buildDocument = () => ({
      paths: {
        "/v2/projects/{ref}/webhooks/endpoints": {
          get: { operationId: "allV2ProjectsByRefWebhooks" },
        },
        "/v2/projects/{ref}/webhooks/endpoints/{id}": {
          get: { operationId: "allV2ProjectsByRefWebhooks" },
        },
        "/v2/projects/{ref}": {
          get: { operationId: "v2-get-a-project" },
        },
      },
    });

    const overrides = [
      { op: "remove", path: "/paths/~1v2~1projects~1{ref}~1webhooks~1endpoints" },
      { op: "remove", path: "/paths/~1v2~1projects~1{ref}~1webhooks~1endpoints~1{id}" },
    ];

    expect(() => assertMergedOpenApiDocument(buildDocument())).toThrow(
      'Duplicate OpenAPI operationId "allV2ProjectsByRefWebhooks"',
    );

    const patchedDocument = applyOpenApiOverrides(buildDocument(), overrides);
    expect(Object.keys(patchedDocument.paths)).toEqual(["/v2/projects/{ref}"]);
    expect(() => assertMergedOpenApiDocument(patchedDocument)).not.toThrow();
  });
});
