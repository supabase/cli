#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SUPABASE_API_URL = "https://api.supabase.com";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const OPENAPI_SPEC_PATH = path.join(scriptDir, "../src/generated/openapi.json");
const OPENAPI_OVERRIDES_PATH = path.join(scriptDir, "openapi-overrides.json");
const OPENAPI_SOURCE_PATH = path.join(scriptDir, "openapi-source.json");

const OPENAPI_DOCUMENT_VERSIONS = ["v1", "v2"] as const;
type OpenApiDocumentVersion = (typeof OPENAPI_DOCUMENT_VERSIONS)[number];

const HTTP_METHOD_KEYS = ["get", "post", "put", "patch", "delete", "head"] as const;

type OpenApiDocument = {
  readonly [key: string]: unknown;
  readonly paths: Record<string, unknown>;
  readonly components?: {
    readonly schemas?: Record<string, unknown>;
  };
};

type OpenApiSource = {
  readonly baseUrl: string;
};

type JsonPatchOperation =
  | {
      readonly op: "add" | "test" | "replace";
      readonly path: string;
      readonly value: unknown;
    }
  | {
      readonly op: "remove";
      readonly path: string;
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

function removeJsonPointerValue(document: unknown, pointer: string): boolean {
  const segments = jsonPointerSegments(pointer);
  if (segments.length === 0) {
    return false;
  }

  let parent: unknown = document;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(parent)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
        return false;
      }
      parent = parent[index];
      continue;
    }
    if (isRecord(parent) && segment in parent) {
      parent = parent[segment];
      continue;
    }
    return false;
  }

  const key = segments[segments.length - 1]!;
  if (Array.isArray(parent)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
      return false;
    }
    parent.splice(index, 1);
    return true;
  }

  if (!isRecord(parent) || !(key in parent)) {
    return false;
  }
  delete parent[key];
  return true;
}

function assertJsonPatchOperation(value: unknown): asserts value is JsonPatchOperation {
  if (!isRecord(value)) {
    throw new Error("OpenAPI override entry must be an object.");
  }
  if (
    value.op !== "add" &&
    value.op !== "test" &&
    value.op !== "replace" &&
    value.op !== "remove"
  ) {
    throw new Error("OpenAPI overrides only support add, test, replace and remove operations.");
  }
  if (typeof value.path !== "string") {
    throw new Error("OpenAPI override path must be a string.");
  }
  if (value.op === "remove") {
    if ("value" in value) {
      throw new Error("OpenAPI remove overrides must not include a value.");
    }
    return;
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
    if (override.op === "remove") {
      // Deliberate deviation from RFC 6902 (mirroring the existing "add"
      // deviation below, which throws when the target key already exists):
      // silently ignore removal of a pointer that doesn't exist. This file
      // applies to documents that differ between environments — staging's
      // /api/v2-json is currently served by two backend variants that
      // disagree about whether the webhook paths exist — so a strict
      // remove would fail on most staging runs.
      removeJsonPointerValue(document, override.path);
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

function assertOpenApiSource(value: unknown): asserts value is OpenApiSource {
  if (!isRecord(value) || typeof value.baseUrl !== "string") {
    throw new Error('OpenAPI source file must be an object with a string "baseUrl" property.');
  }
}

async function loadPinnedBaseUrl(): Promise<string> {
  const parsed = JSON.parse(await readFile(OPENAPI_SOURCE_PATH, "utf8"));
  assertOpenApiSource(parsed);
  return parsed.baseUrl;
}

async function writeOpenApiSource(baseUrl: string): Promise<void> {
  const source: OpenApiSource = { baseUrl };
  await writeFile(OPENAPI_SOURCE_PATH, `${JSON.stringify(source, null, 2)}\n`);
}

export function resolveOpenApiBaseUrl({
  envBaseUrl,
  pinnedBaseUrl,
}: {
  readonly envBaseUrl?: string;
  readonly pinnedBaseUrl?: string;
}): string {
  const baseUrl = envBaseUrl ?? pinnedBaseUrl ?? DEFAULT_SUPABASE_API_URL;
  return baseUrl.replace(/\/+$/, "");
}

export function resolveOpenApiSpecUrl(
  baseUrl = process.env.SUPABASE_API_URL,
  version: OpenApiDocumentVersion = "v1",
): string {
  const normalizedBaseUrl = resolveOpenApiBaseUrl({ envBaseUrl: baseUrl });
  return `${normalizedBaseUrl}/api/${version}-json`;
}

export function resolveOpenApiSpecUrls(
  baseUrl?: string,
): ReadonlyArray<{ readonly version: OpenApiDocumentVersion; readonly url: string }> {
  return OPENAPI_DOCUMENT_VERSIONS.map((version) => ({
    version,
    url: resolveOpenApiSpecUrl(baseUrl, version),
  }));
}

export function assertOpenApiDocument(document: unknown): asserts document is OpenApiDocument {
  if (!isRecord(document) || !isRecord(document.paths)) {
    throw new Error("Downloaded spec is not a valid OpenAPI document with a paths object.");
  }
}

function getOpenApiVersion(document: OpenApiDocument): string {
  if (typeof document.openapi !== "string") {
    throw new Error('OpenAPI document is missing an "openapi" version string.');
  }
  return document.openapi;
}

function getInfoVersion(document: OpenApiDocument): string {
  if (!isRecord(document.info) || typeof document.info.version !== "string") {
    throw new Error('OpenAPI document is missing an "info.version" string.');
  }
  return document.info.version;
}

export function mergeOpenApiDocuments(
  documents: ReadonlyArray<{
    readonly version: OpenApiDocumentVersion;
    readonly document: OpenApiDocument;
  }>,
): OpenApiDocument {
  const [firstEntry, ...restEntries] = documents;
  if (firstEntry === undefined) {
    throw new Error("mergeOpenApiDocuments requires at least one document.");
  }

  const openapiVersion = getOpenApiVersion(firstEntry.document);
  for (const entry of restEntries) {
    const entryOpenapiVersion = getOpenApiVersion(entry.document);
    if (entryOpenapiVersion !== openapiVersion) {
      throw new Error(
        `OpenAPI "openapi" version mismatch between ${firstEntry.version} (${openapiVersion}) and ${entry.version} (${entryOpenapiVersion}).`,
      );
    }
  }

  const infoVersion = getInfoVersion(firstEntry.document);
  for (const entry of restEntries) {
    const entryInfoVersion = getInfoVersion(entry.document);
    if (entryInfoVersion !== infoVersion) {
      throw new Error(
        `OpenAPI "info.version" mismatch between ${firstEntry.version} (${infoVersion}) and ${entry.version} (${entryInfoVersion}).`,
      );
    }
  }

  for (const { version, document } of documents) {
    for (const pathKey of Object.keys(document.paths)) {
      if (!pathKey.startsWith(`/${version}/`)) {
        throw new Error(
          `OpenAPI path ${JSON.stringify(pathKey)} in the ${version} document does not start with "/${version}/".`,
        );
      }
    }
  }

  const paths: Record<string, unknown> = {};
  const pathVersions = new Map<string, OpenApiDocumentVersion>();
  for (const { version, document } of documents) {
    for (const [pathKey, pathValue] of Object.entries(document.paths)) {
      const existingVersion = pathVersions.get(pathKey);
      if (existingVersion !== undefined) {
        throw new Error(
          `Duplicate OpenAPI path ${JSON.stringify(pathKey)} found in both the ${existingVersion} and ${version} documents.`,
        );
      }
      pathVersions.set(pathKey, version);
      paths[pathKey] = pathValue;
    }
  }

  const schemas: Record<string, unknown> = {};
  const schemaVersions = new Map<string, OpenApiDocumentVersion>();
  for (const { version, document } of documents) {
    for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
      const existingVersion = schemaVersions.get(name);
      if (existingVersion === undefined) {
        schemaVersions.set(name, version);
        schemas[name] = schema;
        continue;
      }
      if (!valuesEqual(schemas[name], schema)) {
        throw new Error(
          `Conflicting OpenAPI schema ${JSON.stringify(name)} found in both the ${existingVersion} and ${version} documents.`,
        );
      }
    }
  }

  return {
    ...firstEntry.document,
    openapi: openapiVersion,
    info: { title: "Supabase API", version: infoVersion },
    paths,
    components: { ...firstEntry.document.components, schemas },
  };
}

// Runs AFTER overrides are applied — this ordering is load-bearing. Prod's
// v2 document currently has 20 webhook operations sharing just 2 duplicated
// operationIds, and the overrides remove those paths. Validating before
// overrides were applied would abort every production regeneration.
export function assertMergedOpenApiDocument(document: OpenApiDocument): void {
  const operationClaims = new Map<string, Array<string>>();

  for (const [pathKey, pathValue] of Object.entries(document.paths)) {
    if (!isRecord(pathValue)) {
      continue;
    }
    for (const method of HTTP_METHOD_KEYS) {
      const operation = pathValue[method];
      if (!isRecord(operation)) {
        continue;
      }

      const label = `${method.toUpperCase()} ${pathKey}`;
      const operationId = operation.operationId;
      if (typeof operationId !== "string" || operationId.length === 0) {
        // generate.ts silently skips operations without an operationId; the
        // documented escape hatch is adding a "remove" override for the path.
        console.warn(`OpenAPI operation ${label} has no operationId; generate.ts will skip it.`);
        continue;
      }

      const claims = operationClaims.get(operationId);
      if (claims === undefined) {
        operationClaims.set(operationId, [label]);
      } else {
        claims.push(label);
      }

      const versionPrefixMatch = /^(v\d+)-/i.exec(operationId);
      if (versionPrefixMatch) {
        const prefix = versionPrefixMatch[1]!.toLowerCase();
        const leadingSegment = pathKey.split("/")[1]?.toLowerCase();
        if (leadingSegment !== prefix) {
          throw new Error(
            `OpenAPI operationId ${JSON.stringify(operationId)} for ${label} has version prefix ${JSON.stringify(prefix)} that does not match the path's leading segment ${JSON.stringify(leadingSegment ?? "")}.`,
          );
        }
      }
    }
  }

  for (const [operationId, claims] of operationClaims) {
    if (claims.length > 1) {
      throw new Error(
        `Duplicate OpenAPI operationId ${JSON.stringify(operationId)} claimed by: ${claims.join(", ")}.`,
      );
    }
  }
}

export async function downloadOpenApiSpec(): Promise<void> {
  const pinnedBaseUrl = await loadPinnedBaseUrl();
  const baseUrl = resolveOpenApiBaseUrl({
    envBaseUrl: process.env.SUPABASE_API_URL,
    pinnedBaseUrl,
  });
  console.log(`Resolved OpenAPI base URL: ${baseUrl}`);

  const documents: Array<{
    readonly version: OpenApiDocumentVersion;
    readonly document: OpenApiDocument;
  }> = [];
  for (const { version, url } of resolveOpenApiSpecUrls(baseUrl)) {
    console.log(`Fetching ${version} OpenAPI document from ${url}`);
    const response = await fetch(url);

    // Hard-fail on a missing document instead of tolerating it: a 404 on
    // /api/v2-json would silently delete the whole v2 namespace from the
    // generated client, and the hourly regeneration sync would auto-merge
    // that deletion without anyone noticing.
    if (!response.ok) {
      throw new Error(`Failed to download OpenAPI spec from ${url}: ${response.status}`);
    }

    const document = await response.json();
    assertOpenApiDocument(document);
    documents.push({ version, document });
  }

  const mergedDocument = mergeOpenApiDocuments(documents);
  applyOpenApiOverrides(mergedDocument, await loadOpenApiOverrides());
  assertMergedOpenApiDocument(mergedDocument);

  await writeFile(OPENAPI_SPEC_PATH, `${JSON.stringify(mergedDocument, null, 2)}\n`);
  await writeOpenApiSource(baseUrl);
}

if (import.meta.main) {
  await downloadOpenApiSpec();
}
