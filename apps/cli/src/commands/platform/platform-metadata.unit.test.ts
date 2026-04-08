import { describe, expect, it } from "vitest";
import {
  executeApiClientOperation,
  openApiOperationIdMap,
  operationDefinitions,
} from "@supabase/api/effect";

import { platformOperationDescriptors } from "./platform-descriptors.ts";
import { platformRouteDescriptors, platformRouteDescriptorsByPath } from "./platform-routes.ts";
import {
  platformRouteDescriptorMap,
  platformRouteDescriptorsByPath as platformRouteResolverDescriptorsByPath,
} from "./platform-route-resolver.ts";
import {
  platformOpenApiOperationEntries,
  resolvePlatformOpenApiSchema,
  type PlatformOpenApiSchema,
} from "./platform-openapi.ts";
import type { PlatformSchemaNode } from "./platform-types.ts";

function findPlatformOperationDescriptor(operationId: string) {
  const descriptor = platformOperationDescriptors.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (descriptor === undefined) {
    throw new Error(`No platform operation descriptor was found for ${operationId}.`);
  }
  return descriptor;
}

function walkSchemaNodes(node: PlatformSchemaNode | undefined): ReadonlyArray<PlatformSchemaNode> {
  if (node === undefined) {
    return [];
  }

  return [
    node,
    ...(node.properties?.flatMap((property) => walkSchemaNodes(property)) ?? []),
    ...(node.items ? walkSchemaNodes(node.items) : []),
    ...(node.variants?.flatMap((variant) => walkSchemaNodes(variant)) ?? []),
  ];
}

function rawUnionVariantsFor(schema: PlatformOpenApiSchema): ReadonlyArray<PlatformOpenApiSchema> {
  const resolved = resolvePlatformOpenApiSchema(schema);
  return [...(resolved.oneOf ?? []), ...(resolved.anyOf ?? [])];
}

function isScalarLikeRawSchema(schema: PlatformOpenApiSchema): boolean {
  const resolved = resolvePlatformOpenApiSchema(schema);
  if (resolved.type === "string" || resolved.type === "boolean") {
    return true;
  }
  if (resolved.type === "integer" || resolved.type === "number") {
    return true;
  }

  return (
    Array.isArray(resolved.enum) &&
    resolved.enum.length > 0 &&
    resolved.enum.every((value) => {
      const type = typeof value;
      return type === "string" || type === "number" || type === "boolean";
    })
  );
}

describe("platform route metadata", () => {
  it("covers every exported OpenAPI operation exactly once", () => {
    const operationCount = Object.keys(operationDefinitions).length;

    expect(Object.keys(openApiOperationIdMap)).toHaveLength(operationCount);
    expect(platformRouteDescriptorMap.size).toBe(operationCount);
    expect(platformOperationDescriptors).toHaveLength(operationCount);
  });

  it("indexes descriptors by unique method and route pairs", () => {
    const seen = new Set<string>();

    for (const descriptor of platformOperationDescriptors) {
      const key = `${descriptor.method} ${descriptor.path}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("tracks all available methods for multi-method routes", () => {
    expect(
      platformRouteResolverDescriptorsByPath
        .get("/v1/projects")
        ?.map((descriptor) => descriptor.method),
    ).toEqual(["GET", "POST"]);
    expect(findPlatformOperationDescriptor("v1GetProject").availableMethods).toEqual([
      "GET",
      "PATCH",
      "DELETE",
    ]);
    expect(findPlatformOperationDescriptor("v1GetAuthServiceConfig").availableMethods).toEqual([
      "GET",
      "PATCH",
    ]);
  });

  it("derives one route listing per unique path", () => {
    expect(platformRouteDescriptors).toHaveLength(platformRouteResolverDescriptorsByPath.size);
    expect(platformRouteDescriptorsByPath.get("/v1/projects")).toEqual(
      expect.objectContaining({
        group: "Projects",
        methods: [
          expect.objectContaining({
            method: "GET",
            summary: "List all projects",
            isDefault: true,
          }),
          expect.objectContaining({
            method: "POST",
            summary: "Create a project",
            isDefault: false,
          }),
        ],
      }),
    );
  });

  it("keeps route group metadata consistent with operation tags", () => {
    for (const route of platformRouteDescriptors) {
      const operations = platformRouteResolverDescriptorsByPath.get(route.path);
      expect(operations).toBeDefined();
      expect(new Set(operations?.map((descriptor) => descriptor.group))).toEqual(
        new Set([route.group]),
      );
    }
  });

  it("uses the generated API-owned platform executor", () => {
    expect(typeof executeApiClientOperation).toBe("function");
    for (const descriptor of platformOperationDescriptors) {
      expect(typeof descriptor.execute).toBe("function");
    }
  });

  it("describes request body kinds from raw OpenAPI metadata", () => {
    expect(findPlatformOperationDescriptor("v1CreateAProject").request.body).toEqual(
      expect.objectContaining({
        kind: "json",
        schema: expect.objectContaining({
          kind: "object",
          properties: expect.arrayContaining([
            expect.objectContaining({ name: "db_pass", sensitive: true, required: true }),
            expect.objectContaining({ name: "organization_slug", required: true }),
          ]),
        }),
      }),
    );

    expect(findPlatformOperationDescriptor("v1BulkCreateSecrets").request.body).toEqual(
      expect.objectContaining({
        kind: "json",
        fieldName: "body",
        schema: expect.objectContaining({
          kind: "array",
        }),
      }),
    );

    expect(findPlatformOperationDescriptor("v1DeployAFunction").request.body).toEqual(
      expect.objectContaining({
        kind: "multipart",
        fieldName: "body",
        contentType: "multipart/form-data",
      }),
    );

    expect(findPlatformOperationDescriptor("v1ExchangeOauthToken").request.body).toEqual(
      expect.objectContaining({
        kind: "urlencoded",
        fieldName: "body",
        contentType: "application/x-www-form-urlencoded",
      }),
    );
  });

  it("collapses string-only OpenAPI unions into plain string or enum fields", () => {
    expect(findPlatformOperationDescriptor("v1DeleteABranch").request.params).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "branch_id_or_ref",
          kind: "string",
        }),
      ]),
    );

    expect(findPlatformOperationDescriptor("v1RemoveProjectAddon").request.params).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "addon_variant",
          kind: "enum",
          enumValues: expect.arrayContaining(["ci_micro", "cd_default", "pitr_28"]),
        }),
      ]),
    );
  });

  it("keeps mixed-type OpenAPI unions as true union fields", () => {
    expect(findPlatformOperationDescriptor("v1CreateAProject").request.body).toEqual(
      expect.objectContaining({
        schema: expect.objectContaining({
          properties: expect.arrayContaining([
            expect.objectContaining({
              name: "region_selection",
              kind: "union",
            }),
          ]),
        }),
      }),
    );
  });

  it("keeps top-level request metadata promptable and free of obvious scalar mismatches", () => {
    const entriesByOperationId = new Map(
      platformOpenApiOperationEntries.map((entry) => [entry.sdkOperationId, entry] as const),
    );

    for (const descriptor of platformOperationDescriptors) {
      const allRequestNodes = [
        ...descriptor.request.params.flatMap((field) => walkSchemaNodes(field)),
        ...walkSchemaNodes(descriptor.request.body.schema),
      ];

      for (const node of allRequestNodes) {
        if (node.kind === "enum") {
          expect(node.enumValues?.length ?? 0).toBeGreaterThan(0);
        }
      }

      const entry = entriesByOperationId.get(descriptor.operationId);
      expect(entry).toBeDefined();
      if (entry === undefined) {
        continue;
      }

      const rawParams = entry.parameters;
      for (const field of descriptor.request.params) {
        if (field.name === undefined || field.kind === "union") {
          continue;
        }

        const rawParam = rawParams.find((candidate) => candidate.name === field.name);
        if (!rawParam?.schema) {
          continue;
        }

        const rawVariants = rawUnionVariantsFor(rawParam.schema);
        if (rawVariants.length > 0 && rawVariants.every(isScalarLikeRawSchema)) {
          expect(field.kind === "string" || field.kind === "enum").toBe(true);
        }
      }
    }
  });
});
