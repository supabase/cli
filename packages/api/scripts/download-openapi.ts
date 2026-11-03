#!/usr/bin/env bun
import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { Config, ConfigProvider, Console, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

const DEFAULT_SUPABASE_API_URL = "https://api.supabase.com";
const OPENAPI_SPEC_PATH = fileURLToPath(new URL("../src/generated/openapi.json", import.meta.url));
const OPENAPI_OVERRIDES_PATH = fileURLToPath(new URL("openapi-overrides.json", import.meta.url));
const OPENAPI_SOURCE_PATH = fileURLToPath(new URL("openapi-source.json", import.meta.url));

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

type JsonPatchOperation = (
  | {
      readonly op: "add" | "test" | "replace";
      readonly path: string;
      readonly value: unknown;
    }
  | {
      readonly op: "remove";
      readonly path: string;
    }
) & {
  readonly $comment?: unknown;
};

class OpenApiDownloadError extends Schema.TaggedError<OpenApiDownloadError>()(
  "OpenApiDownloadError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const downloadStep = <A>(step: () => A) =>
  Effect.try({
    try: step,
    catch: (cause) =>
      new OpenApiDownloadError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodePrettyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

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

function pointerFromSegments(segments: ReadonlyArray<string>): string {
  return segments.map((segment) => `/${segment.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
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

  const parent = getJsonPointerValue(document, pointerFromSegments(segments.slice(0, -1)));

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

  const parent = getJsonPointerValue(document, pointerFromSegments(segments.slice(0, -1)));

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

function removeJsonPointerValue(document: unknown, pointer: string): void {
  const segments = jsonPointerSegments(pointer);
  if (segments.length === 0) {
    throw new Error("Removing the document root is not supported.");
  }

  const parent = getJsonPointerValue(document, pointerFromSegments(segments.slice(0, -1)));
  const key = segments[segments.length - 1]!;
  if (Array.isArray(parent)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
      throw new Error(`JSON pointer ${JSON.stringify(pointer)} does not exist.`);
    }
    parent.splice(index, 1);
    return;
  }

  if (!isRecord(parent) || !(key in parent)) {
    throw new Error(`JSON pointer ${JSON.stringify(pointer)} does not exist.`);
  }
  delete parent[key];
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
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => valuesEqual(entry, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    return (
      leftKeys.length === Object.keys(right).length &&
      leftKeys.every((key) => key in right && valuesEqual(left[key], right[key]))
    );
  }
  return left === right;
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
      removeJsonPointerValue(document, override.path);
      continue;
    }
    if (valuesEqual(getJsonPointerValue(document, override.path), override.value)) {
      throw new Error(
        `OpenAPI override replace at ${override.path} is redundant: upstream already has ${JSON.stringify(override.value)}.`,
      );
    }
    replaceJsonPointerValue(document, override.path, override.value);
  }
  return document;
}

function hasComment(override: JsonPatchOperation): boolean {
  return typeof override.$comment === "string" && override.$comment.trim().length > 0;
}

/**
 * Validates the override list's structure: every `replace` is guarded by a `test` on the same
 * path directly before it, and every test+replace pair or standalone entry explains its upstream
 * cause in a `$comment`.
 */
export function parseOpenApiOverrides(parsed: unknown): ReadonlyArray<JsonPatchOperation> {
  if (!Array.isArray(parsed)) {
    throw new Error("OpenAPI overrides file must contain a JSON Patch array.");
  }
  const entries: Array<JsonPatchOperation> = [];
  for (const override of parsed) {
    assertJsonPatchOperation(override);
    entries.push(override);
  }

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const next = entries[index + 1];
    const isGuardedPair = entry.op === "test" && next?.op === "replace" && next.path === entry.path;
    if (entry.op === "replace") {
      throw new Error(
        `OpenAPI override replace at ${entry.path} must be directly preceded by a test on the same path.`,
      );
    }
    if (!hasComment(entry) && !(isGuardedPair && hasComment(next))) {
      throw new Error(`OpenAPI override ${entry.op} at ${entry.path} needs a $comment.`);
    }
    if (isGuardedPair) {
      index++;
    }
  }
  return entries;
}

export const loadOpenApiOverrides = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const source = utf8.decode(yield* fs.readFile(OPENAPI_OVERRIDES_PATH));
  return yield* downloadStep(() => parseOpenApiOverrides(JSON.parse(source)));
});

function assertOpenApiSource(value: unknown): asserts value is OpenApiSource {
  if (!isRecord(value) || typeof value.baseUrl !== "string") {
    throw new Error('OpenAPI source file must be an object with a string "baseUrl" property.');
  }
}

const loadPinnedBaseUrl = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFile(OPENAPI_SOURCE_PATH).pipe(
    Effect.map((bytes) => Option.some(utf8.decode(bytes))),
    // A missing pin falls through to the default base URL; only a present
    // but malformed pin is an error worth stopping for.
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none<string>())),
  );
  if (Option.isNone(raw)) {
    return undefined;
  }
  return yield* downloadStep(() => {
    const parsed = JSON.parse(raw.value);
    assertOpenApiSource(parsed);
    return parsed.baseUrl;
  });
});

const writeOpenApiSource = (baseUrl: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const source: OpenApiSource = { baseUrl };
    yield* fs.writeFileString(OPENAPI_SOURCE_PATH, `${yield* encodePrettyJson(source)}\n`);
  });

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
  baseUrl: string | undefined,
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

  // Carries only the keys the generator consumes; upstream extras (`servers`,
  // `tags`, `components.securitySchemes`, …) are dropped so a crash before
  // generate.ts finishes can't leave a stale-looking but inconsistent openapi.json.
  return {
    openapi: openapiVersion,
    info: { title: "Supabase API", version: infoVersion },
    paths,
    components: { schemas },
  };
}

export const assertMergedOpenApiDocument = Effect.fnUntraced(function* (document: OpenApiDocument) {
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
        yield* Console.warn(
          `OpenAPI operation ${label} has no operationId; generate.ts will skip it.`,
        );
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
          return yield* new OpenApiDownloadError({
            message: `OpenAPI operationId ${yield* encodeJson(operationId)} for ${label} has version prefix ${yield* encodeJson(prefix)} that does not match the path's leading segment ${yield* encodeJson(leadingSegment ?? "")}.`,
          });
        }
      }
    }
  }

  for (const [operationId, claims] of operationClaims) {
    if (claims.length > 1) {
      return yield* new OpenApiDownloadError({
        message: `Duplicate OpenAPI operationId ${yield* encodeJson(operationId)} claimed by: ${claims.join(", ")}.`,
      });
    }
  }
});

export const downloadOpenApiSpec = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const client = yield* HttpClient.HttpClient;
  const envBaseUrl = Option.getOrUndefined(yield* Config.option(Config.String("SUPABASE_API_URL")));
  // The pin is consulted only when the environment doesn't override it, so an
  // explicit SUPABASE_API_URL works even when the pin is absent or malformed.
  const pinnedBaseUrl = envBaseUrl === undefined ? yield* loadPinnedBaseUrl : undefined;
  const baseUrl = resolveOpenApiBaseUrl({ envBaseUrl, pinnedBaseUrl });
  yield* Console.log(`Resolved OpenAPI base URL: ${baseUrl}`);

  const documents: Array<{
    readonly version: OpenApiDocumentVersion;
    readonly document: OpenApiDocument;
  }> = [];
  for (const { version, url } of resolveOpenApiSpecUrls(baseUrl)) {
    yield* Console.log(`Fetching ${version} OpenAPI document from ${url}`);
    const response = yield* client.get(url);

    // Hard-fails on a missing document instead of tolerating it: a 404 would
    // silently drop the whole v2 namespace, and the hourly regeneration sync
    // would auto-merge that deletion unnoticed.
    if (response.status < 200 || response.status > 299) {
      return yield* new OpenApiDownloadError({
        message: `Failed to download OpenAPI spec from ${url}: ${response.status}`,
      });
    }

    const body = yield* response.json;
    const document = yield* downloadStep(() => {
      assertOpenApiDocument(body);
      return body;
    });
    documents.push({ version, document });
  }

  const mergedDocument = yield* downloadStep(() => mergeOpenApiDocuments(documents));
  const overrides = yield* loadOpenApiOverrides;
  yield* downloadStep(() => applyOpenApiOverrides(mergedDocument, overrides));
  yield* assertMergedOpenApiDocument(mergedDocument);

  yield* fs.writeFileString(OPENAPI_SPEC_PATH, `${yield* encodePrettyJson(mergedDocument)}\n`);
  yield* writeOpenApiSource(baseUrl);
});

if (import.meta.main) {
  await Effect.runPromise(
    downloadOpenApiSpec.pipe(
      /* Crash with the step's original error so the uncaught report names it, not the wrapper. */
      Effect.catchTags({
        OpenApiDownloadError: (error) => Effect.die(error.cause ?? error),
        HttpClientError: (error) => Effect.die(error.cause ?? error),
        PlatformError: (error) => Effect.die(error.cause ?? error),
      }),
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          FetchHttpClient.layer,
          Layer.succeed(HttpClient.TracerPropagationEnabled, false),
          ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
        ),
      ),
    ),
  );
}
