import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import * as Schema from "effect/Schema";
import { describe, expect, test } from "vitest";

import { openApiOperationIdMap, operationDefinitions } from "./generated/contracts.ts";
import { versionedEffectOperations } from "./generated/effect-client.ts";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

interface OpenApiOperationObject {
  readonly operationId?: string;
}

type OpenApiPathItem = Readonly<Record<string, OpenApiOperationObject | undefined>>;

interface OpenApiDocumentShape {
  readonly paths: Readonly<Record<string, OpenApiPathItem>>;
}

interface SnapshotOperation {
  readonly path: string;
  readonly method: string;
  readonly operationId: string;
}

const openApiSnapshot = await Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const openApiJsonPath = yield* path.fromFileUrl(
    new URL("./generated/openapi.json", import.meta.url),
  );
  return {
    raw: yield* fs.readFileString(openApiJsonPath),
  };
}).pipe(Effect.provide(BunServices.layer), Effect.runPromise);

const rawOpenApiJson = openApiSnapshot.raw;
const parsedOpenApiDocument = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
  rawOpenApiJson,
);

function extractSnapshotOperations(
  document: OpenApiDocumentShape,
): ReadonlyArray<SnapshotOperation> {
  const operations: Array<SnapshotOperation> = [];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation?.operationId) {
        continue;
      }
      operations.push({ path, method: method.toUpperCase(), operationId: operation.operationId });
    }
  }
  return operations;
}

function leadingPathSegment(path: string): string {
  const segment = path.split("/")[1];
  if (segment === undefined) {
    throw new Error(`Expected a version-prefixed path, got "${path}"`);
  }
  return segment;
}

// Mirrors scripts/generate.ts's operationMethodName: strips the leading
// version prefix from the SDK operation id and lowercases the character that
// follows it, e.g. "v2GetProjectConfig" -> "getProjectConfig".
function methodNameFromSdkOperationId(sdkOperationId: string): string {
  const match = /^v\d+(.+)$/.exec(sdkOperationId);
  const rest = match?.[1];
  if (!rest) {
    return sdkOperationId;
  }
  return `${rest[0]!.toLowerCase()}${rest.slice(1)}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isOpenApiDocument(value: unknown): value is OpenApiDocumentShape {
  return isRecord(value) && isRecord(value.paths);
}

if (!isOpenApiDocument(parsedOpenApiDocument)) {
  throw new Error("Expected an OpenAPI document with a paths object");
}

const openApiDocument = parsedOpenApiDocument;

function stringProperty(value: unknown, key: string): string {
  if (!isRecord(value)) {
    throw new Error(`Expected an object while reading property "${key}"`);
  }
  const propertyValue = value[key];
  if (typeof propertyValue !== "string") {
    throw new Error(`Expected a string property "${key}", got ${typeof propertyValue}`);
  }
  return propertyValue;
}

const operationIdMap = new Map<string, string>(Object.entries(openApiOperationIdMap));
const definitionsByOperationName = new Map<string, unknown>(Object.entries(operationDefinitions));
const versionedOperationsByVersion = new Map<string, unknown>(
  Object.entries(versionedEffectOperations),
);

function versionedOperationFunction(version: string, methodName: string): unknown {
  const operations = versionedOperationsByVersion.get(version);
  if (!isRecord(operations)) {
    return undefined;
  }
  return operations[methodName];
}

const snapshotOperations = extractSnapshotOperations(openApiDocument);

describe("generated client drift against the committed openapi.json snapshot", () => {
  test("maps every snapshot operation to a matching generated contract and versioned client method", () => {
    for (const { path, method, operationId } of snapshotOperations) {
      const sdkOperationId = operationIdMap.get(operationId);
      expect(sdkOperationId, `no openApiOperationIdMap entry for "${operationId}"`).toBeDefined();
      if (sdkOperationId === undefined) {
        continue;
      }

      const definition = definitionsByOperationName.get(sdkOperationId);
      expect(
        definition,
        `no operationDefinitions entry for "${sdkOperationId}" (${method} ${path})`,
      ).toBeDefined();

      expect(stringProperty(definition, "method")).toBe(method);
      expect(stringProperty(definition, "path")).toBe(path);

      const namespace = leadingPathSegment(path);
      const methodName = methodNameFromSdkOperationId(sdkOperationId);
      expect(
        typeof versionedOperationFunction(namespace, methodName),
        `versionedEffectOperations.${namespace}.${methodName} is not a function for "${sdkOperationId}" (${method} ${path})`,
      ).toBe("function");
    }
  });

  test("does not carry a hand-added or stale operation in the generated contracts", () => {
    const sdkOperationIdsFromSnapshot = snapshotOperations.map(({ operationId }) =>
      operationIdMap.get(operationId),
    );

    expect(new Set(sdkOperationIdsFromSnapshot).size).toBe(sdkOperationIdsFromSnapshot.length);
    expect(sdkOperationIdsFromSnapshot.length).toBe(Object.keys(operationDefinitions).length);
    expect(new Set(sdkOperationIdsFromSnapshot)).toEqual(
      new Set(Object.keys(operationDefinitions)),
    );
  });

  test("does not carry a hand-added or stale method on the versioned effect client", () => {
    const totalVersionedOperationFunctions = Array.from(
      versionedOperationsByVersion.values(),
    ).reduce<number>(
      (total, operations) =>
        isRecord(operations) ? total + Object.keys(operations).length : total,
      0,
    );

    const versionMethodPairsFromSnapshot = new Set(
      snapshotOperations.map(({ path, operationId }) => {
        const sdkOperationId = operationIdMap.get(operationId);
        return `${leadingPathSegment(path)}.${
          sdkOperationId ? methodNameFromSdkOperationId(sdkOperationId) : operationId
        }`;
      }),
    );

    expect(versionMethodPairsFromSnapshot.size).toBe(snapshotOperations.length);
    expect(totalVersionedOperationFunctions).toBe(snapshotOperations.length);
  });

  test("exposes exactly the API versions present in the snapshot as top-level namespaces", () => {
    const versionsFromSnapshot = new Set(
      snapshotOperations.map(({ path }) => leadingPathSegment(path)),
    );

    expect(Object.keys(versionedEffectOperations).sort()).toEqual(
      Array.from(versionsFromSnapshot).sort(),
    );
    expect(versionsFromSnapshot).toContain("v1");
    expect(versionsFromSnapshot).toContain("v2");
  });

  // A byte-for-byte `JSON.stringify(parsed, null, 2) + "\n"` reproduction of
  // the committed file does not hold: oxfmt collapses short arrays (e.g.
  // `"tags": ["Environments"]`) onto a single line after generation, so a
  // naive re-stringify diverges purely on formatting, not content. This
  // instead checks that the committed bytes parse deterministically and keep
  // the single trailing newline `scripts/generate.ts` writes.
  test("parses the committed snapshot deterministically and keeps a single trailing newline", () => {
    const reparsedUnknown = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
      rawOpenApiJson,
    );
    expect(isOpenApiDocument(reparsedUnknown)).toBe(true);
    if (!isOpenApiDocument(reparsedUnknown)) {
      return;
    }
    const reparsed = reparsedUnknown;
    expect(reparsed).toEqual(openApiDocument);
    expect(rawOpenApiJson.endsWith("\n")).toBe(true);
    expect(rawOpenApiJson.endsWith("\n\n")).toBe(false);
  });
});
