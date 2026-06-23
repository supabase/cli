#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SUPABASE_API_URL = "https://api.supabase.com";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const OPENAPI_SPEC_PATH = path.join(scriptDir, "../src/generated/openapi.json");
const OPENAPI_OVERRIDES_PATH = path.join(scriptDir, "openapi-overrides.json");

type OpenApiDocument = {
  readonly [key: string]: unknown;
  readonly paths: Record<string, unknown>;
};

type JsonPatchOperation = {
  readonly op: "add" | "test" | "replace";
  readonly path: string;
  readonly value: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unescapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function jsonPointerSegments(pointer: string): ReadonlyArray<string> {
  if (pointer === "") {
    return [];
  }
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON pointer ${JSON.stringify(pointer)}.`);
  }
  return pointer.slice(1).split("/").map(unescapeJsonPointerSegment);
}

function getJsonPointerValue(document: unknown, pointer: string): unknown {
  let current = document;
  for (const segment of jsonPointerSegments(pointer)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`JSON pointer ${JSON.stringify(pointer)} does not exist.`);
      }
      current = current[index];
    } else if (isRecord(current) && segment in current) {
      current = current[segment];
    } else {
      throw new Error(`JSON pointer ${JSON.stringify(pointer)} does not exist.`);
    }
  }
  return current;
}

function replaceJsonPointerValue(document: unknown, pointer: string, value: unknown): void {
  const segments = jsonPointerSegments(pointer);
  if (segments.length === 0) {
    throw new Error("Replacing the document root is not supported.");
  }

  let parent = document;
  for (const segment of segments.slice(0, -1)) {
    parent = getJsonPointerValue(parent, `/${segment.replace(/~/g, "~0").replace(/\//g, "~1")}`);
  }

  const key = segments[segments.length - 1]!;
  if (Array.isArray(parent)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
      throw new Error(`JSON pointer ${JSON.stringify(pointer)} does not exist.`);
    }
    parent[index] = value;
    return;
  }

  if (!isRecord(parent) || !(key in parent)) {
    throw new Error(`JSON pointer ${JSON.stringify(pointer)} does not exist.`);
  }
  parent[key] = value;
}

function addJsonPointerValue(document: unknown, pointer: string, value: unknown): void {
  const segments = jsonPointerSegments(pointer);
  if (segments.length === 0) {
    throw new Error("Adding the document root is not supported.");
  }

  let parent = document;
  for (const segment of segments.slice(0, -1)) {
    parent = getJsonPointerValue(parent, `/${segment.replace(/~/g, "~0").replace(/\//g, "~1")}`);
  }

  const key = segments[segments.length - 1]!;
  if (Array.isArray(parent)) {
    const index = key === "-" ? parent.length : Number(key);
    if (!Number.isInteger(index) || index < 0 || index > parent.length) {
      throw new Error(`JSON pointer ${JSON.stringify(pointer)} cannot be added.`);
    }
    parent.splice(index, 0, value);
    return;
  }

  if (!isRecord(parent) || key in parent) {
    throw new Error(`JSON pointer ${JSON.stringify(pointer)} cannot be added.`);
  }
  parent[key] = value;
}

function assertJsonPatchOperation(value: unknown): asserts value is JsonPatchOperation {
  if (!isRecord(value)) {
    throw new Error("OpenAPI override entry must be an object.");
  }
  if (value.op !== "add" && value.op !== "test" && value.op !== "replace") {
    throw new Error("OpenAPI overrides only support add, test and replace operations.");
  }
  if (typeof value.path !== "string") {
    throw new Error("OpenAPI override path must be a string.");
  }
  if (!("value" in value)) {
    throw new Error("OpenAPI override value is required.");
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function applyOpenApiOverrides(
  document: OpenApiDocument,
  overrides: ReadonlyArray<unknown>,
): OpenApiDocument {
  for (const override of overrides) {
    assertJsonPatchOperation(override);
    if (override.op === "test") {
      const actual = getJsonPointerValue(document, override.path);
      if (!valuesEqual(actual, override.value)) {
        throw new Error(
          `OpenAPI override test failed at ${override.path}: expected ${JSON.stringify(override.value)}, got ${JSON.stringify(actual)}.`,
        );
      }
      continue;
    }
    if (override.op === "add") {
      addJsonPointerValue(document, override.path, override.value);
      continue;
    }
    replaceJsonPointerValue(document, override.path, override.value);
  }
  return document;
}

async function loadOpenApiOverrides(): Promise<ReadonlyArray<unknown>> {
  const parsed = JSON.parse(await readFile(OPENAPI_OVERRIDES_PATH, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("OpenAPI overrides file must contain a JSON Patch array.");
  }
  return parsed;
}

export function resolveOpenApiSpecUrl(baseUrl = process.env.SUPABASE_API_URL): string {
  const normalizedBaseUrl = (baseUrl ?? DEFAULT_SUPABASE_API_URL).replace(/\/+$/, "");
  return `${normalizedBaseUrl}/api/v1-json`;
}

export function assertOpenApiDocument(document: unknown): asserts document is OpenApiDocument {
  if (!isRecord(document) || !isRecord(document.paths)) {
    throw new Error("Downloaded spec is not a valid OpenAPI document with a paths object.");
  }
}

export async function downloadOpenApiSpec(specUrl = resolveOpenApiSpecUrl()): Promise<void> {
  const response = await fetch(specUrl);

  if (!response.ok) {
    throw new Error(`Failed to download OpenAPI spec from ${specUrl}: ${response.status}`);
  }

  const document = await response.json();
  assertOpenApiDocument(document);

  applyOpenApiOverrides(document, await loadOpenApiOverrides());

  await writeFile(OPENAPI_SPEC_PATH, `${JSON.stringify(document, null, 2)}\n`);
}

if (import.meta.main) {
  await downloadOpenApiSpec();
}
