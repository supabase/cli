import { describe, expect, test } from "vitest";

import {
  applyOpenApiOverrides,
  assertOpenApiDocument,
  resolveOpenApiSpecUrl,
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
});
