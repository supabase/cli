#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SUPABASE_API_URL = "https://api.supabase.com";
const OPENAPI_SPEC_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/generated/openapi.json",
);

type OpenApiDocument = {
  readonly paths: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

  await writeFile(OPENAPI_SPEC_PATH, `${JSON.stringify(document, null, 2)}\n`);
}

if (import.meta.main) {
  await downloadOpenApiSpec();
}
