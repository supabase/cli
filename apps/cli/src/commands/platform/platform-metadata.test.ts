import { describe, expect, it } from "vitest";
import { openApiOperationIdMap, operationDefinitions } from "@supabase/api/effect";

import { platformOperationMap } from "./platform-operation-map.ts";
import { platformOperationDescriptors } from "./platform-descriptors.ts";
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

function hasPrefix(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length < right.length && left.every((segment, index) => segment === right[index]);
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
  if (resolved.type === "string") {
    return true;
  }
  if (resolved.type === "boolean") {
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

describe("platform command metadata", () => {
  it("covers every exported OpenAPI operation exactly once", () => {
    const operationCount = Object.keys(operationDefinitions).length;

    expect(Object.keys(openApiOperationIdMap)).toHaveLength(operationCount);
    expect(platformOperationMap.size).toBe(operationCount);
    expect(platformOperationDescriptors).toHaveLength(operationCount);
  });

  it("normalizes awkward command paths and exposes the missing bulk endpoints", () => {
    expect(findPlatformOperationDescriptor("v1AuthorizeUser").commandPath).toEqual([
      "platform",
      "oauth",
      "authorize",
    ]);
    expect(findPlatformOperationDescriptor("v1DiffABranch").commandPath).toEqual([
      "platform",
      "branches",
      "diff",
    ]);
    expect(findPlatformOperationDescriptor("v1ListJitAccess").commandPath).toEqual([
      "platform",
      "projects",
      "database",
      "jit",
      "list",
    ]);
    expect(findPlatformOperationDescriptor("v1BulkCreateSecrets").commandPath).toEqual([
      "platform",
      "projects",
      "secrets",
      "bulk-create",
    ]);
    expect(findPlatformOperationDescriptor("v1BulkDeleteSecrets").commandPath).toEqual([
      "platform",
      "projects",
      "secrets",
      "bulk-delete",
    ]);
    expect(findPlatformOperationDescriptor("v1BulkUpdateFunctions").commandPath).toEqual([
      "platform",
      "projects",
      "functions",
      "bulk-update",
    ]);
  });

  it("has no duplicate or prefix-conflicting command paths", () => {
    const seen = new Set<string>();
    const paths = platformOperationDescriptors.map((descriptor) => descriptor.commandPath);

    for (const commandPath of paths) {
      const key = commandPath.join("/");
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }

    for (const left of paths) {
      for (const right of paths) {
        if (left === right) {
          continue;
        }
        expect(hasPrefix(left, right)).toBe(false);
      }
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

      for (const field of descriptor.request.params) {
        if (
          field.kind !== "union" ||
          field.name === undefined ||
          (field.location !== "path" && field.location !== "query" && field.location !== "header")
        ) {
          continue;
        }

        const rawParameter = entry?.parameters.find(
          (parameter) => parameter.name === field.name && parameter.in === field.location,
        );

        expect(rawParameter?.schema).toBeDefined();
        if (rawParameter?.schema === undefined) {
          continue;
        }

        const rawVariants = rawUnionVariantsFor(rawParameter.schema);

        if (rawVariants.length > 0) {
          expect(rawVariants.every(isScalarLikeRawSchema)).toBe(false);
        }
      }
    }
  });
});
