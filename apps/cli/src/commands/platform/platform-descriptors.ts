import { Effect, Schema } from "effect";
import { type OperationId, SupabaseApiClient } from "@supabase/api/effect";

import type { PlatformOperationDescriptor } from "./platform-types.ts";
import { getPlatformCommandPath } from "./platform-operation-map.ts";
import { platformOpenApiOperationEntries } from "./platform-openapi.ts";
import {
  buildPlatformRequestDescriptor,
  buildPlatformResponseSchema,
} from "./platform-schema-introspection.ts";

function firstSentence(description: string): string {
  const sentence = description.match(/^[^.?!]+[.?!]?/u)?.[0]?.trim();
  return sentence && sentence.length > 0 ? sentence : description;
}

function buildPlatformOperationDescriptor(
  entry: (typeof platformOpenApiOperationEntries)[number],
): PlatformOperationDescriptor {
  const operationId: OperationId = entry.sdkOperationId;
  const definition = entry.definition;

  return {
    operationId,
    commandPath: getPlatformCommandPath(operationId),
    method: entry.method,
    path: entry.path,
    shortDescription: firstSentence(entry.description),
    description: entry.description,
    successMessage: "Request completed.",
    confirmsMutation: entry.method !== "GET" && entry.method !== "HEAD",
    inputSchema: definition.inputSchema,
    definition,
    execute: (input) =>
      Effect.gen(function* () {
        const client = yield* SupabaseApiClient;
        const decoded = yield* Schema.decodeUnknownEffect(definition.inputSchema)(input);
        return yield* client.execute(definition, decoded);
      }),
    request: buildPlatformRequestDescriptor(entry),
    responseSchema: buildPlatformResponseSchema(entry),
  };
}

export const platformOperationDescriptors: ReadonlyArray<PlatformOperationDescriptor> =
  platformOpenApiOperationEntries
    .map((entry) => buildPlatformOperationDescriptor(entry))
    .sort((left, right) => left.commandPath.join(".").localeCompare(right.commandPath.join(".")));
