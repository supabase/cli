import { Effect, Schema } from "effect";
import {
  executeApiClientOperation,
  type OperationDefinition,
  type OperationId,
} from "@supabase/api/effect";

import { PlatformApi } from "../../auth/platform-api.service.ts";
import { PlatformMetadataError } from "./platform.errors.ts";
import type { PlatformOperationDescriptor } from "./platform-types.ts";
import { platformOpenApiOperationEntries } from "./platform-openapi.ts";
import {
  buildPlatformRequestDescriptor,
  buildPlatformResponseSchema,
} from "./platform-schema-introspection.ts";

function firstSentence(description: string): string {
  const sentence = description.match(/^[^.?!]+[.?!]?/u)?.[0]?.trim();
  return sentence && sentence.length > 0 ? sentence : description;
}

function fallbackSummary(
  summary: string | undefined,
  description: string | undefined,
  operationId: string,
): string {
  return summary ?? (description ? firstSentence(description) : operationId);
}

function compareMethods(
  left: PlatformOperationDescriptor["method"],
  right: PlatformOperationDescriptor["method"],
) {
  const order: ReadonlyArray<PlatformOperationDescriptor["method"]> = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
  ];
  return order.indexOf(left) - order.indexOf(right);
}

const methodsByPath = new Map<string, ReadonlyArray<PlatformOperationDescriptor["method"]>>(
  [
    ...platformOpenApiOperationEntries
      .reduce((map, entry) => {
        const current = map.get(entry.path);
        if (current === undefined) {
          map.set(entry.path, [entry.method]);
          return map;
        }
        if (!current.includes(entry.method)) {
          current.push(entry.method);
        }
        return map;
      }, new Map<string, Array<PlatformOperationDescriptor["method"]>>())
      .entries(),
  ].map(([path, methods]) => [path, [...methods].sort(compareMethods)] as const),
);

function buildPlatformExecute(operationId: OperationId, definition: OperationDefinition) {
  return (input: unknown) =>
    Effect.gen(function* () {
      const api = yield* PlatformApi;
      const decoded = yield* Schema.decodeUnknownEffect(definition.inputSchema)(input);
      return yield* executeApiClientOperation(operationId, api, decoded);
    });
}

function buildPlatformOperationDescriptor(
  entry: (typeof platformOpenApiOperationEntries)[number],
): PlatformOperationDescriptor {
  const primaryTag = entry.tags[0]?.trim();
  if (primaryTag === undefined || primaryTag.length === 0) {
    throw new PlatformMetadataError({
      message: "OpenAPI operation is missing a tag for route discovery grouping.",
      detail: entry.rawOperationId,
    });
  }

  const operationId: OperationId = entry.sdkOperationId;
  const definition = entry.definition;
  const execute = buildPlatformExecute(operationId, definition);
  const shortDescription = fallbackSummary(entry.summary, entry.description, entry.rawOperationId);
  const description = entry.description ?? entry.summary ?? "";

  return {
    operationId,
    method: entry.method,
    path: entry.path,
    group: primaryTag,
    availableMethods: methodsByPath.get(entry.path) ?? [entry.method],
    shortDescription,
    description,
    successMessage: "Request completed.",
    confirmsMutation: entry.method !== "GET" && entry.method !== "HEAD",
    inputSchema: definition.inputSchema,
    definition,
    execute,
    request: buildPlatformRequestDescriptor(entry),
    responseSchema: buildPlatformResponseSchema(entry),
  };
}

export const platformOperationDescriptors: ReadonlyArray<PlatformOperationDescriptor> =
  platformOpenApiOperationEntries
    .map((entry) => buildPlatformOperationDescriptor(entry))
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) || compareMethods(left.method, right.method),
    );
