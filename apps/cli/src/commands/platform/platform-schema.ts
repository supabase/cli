import { PlatformMethodNotFoundError } from "./platform.errors.ts";
import { buildPlatformGeneratedExamples } from "./platform-examples.ts";
import type { PlatformOperationDescriptor, PlatformSchemaNode } from "./platform-types.ts";

function toMethodName(commandPath: readonly [string, ...string[]]): string {
  return commandPath.slice(1).join(".");
}

function collectProjectionPaths(
  node: PlatformSchemaNode | undefined,
  prefix = "",
): ReadonlyArray<string> {
  if (node === undefined) {
    return [];
  }

  const currentPrefix = node.name
    ? prefix.length === 0
      ? node.name
      : `${prefix}.${node.name}`
    : prefix;

  const properties = node.properties ?? [];
  if (properties.length === 0) {
    return currentPrefix.length > 0 ? [currentPrefix] : [];
  }

  const nested = properties.flatMap((property) => collectProjectionPaths(property, currentPrefix));
  if (currentPrefix.length === 0) {
    return nested;
  }
  return [currentPrefix, ...nested];
}

export function buildPlatformSchemaPayload(descriptor: PlatformOperationDescriptor) {
  const generatedExamples = buildPlatformGeneratedExamples(descriptor);

  return {
    method: toMethodName(descriptor.commandPath),
    command: `supabase ${descriptor.commandPath.join(" ")}`,
    description: descriptor.description,
    http: {
      method: descriptor.method,
      path: descriptor.path,
    },
    request: {
      params: descriptor.request.params,
      ...(descriptor.request.body.kind === "none"
        ? {}
        : {
            body: {
              kind: descriptor.request.body.kind,
              ...(descriptor.request.body.contentType
                ? { contentType: descriptor.request.body.contentType }
                : {}),
              ...(descriptor.request.body.schema ? { schema: descriptor.request.body.schema } : {}),
            },
          }),
    },
    ...(generatedExamples.inputHelp ? { inputHelp: generatedExamples.inputHelp } : {}),
    ...(generatedExamples.commandExamples.length > 0
      ? { examples: generatedExamples.commandExamples }
      : {}),
    ...(descriptor.responseSchema ? { response: descriptor.responseSchema } : {}),
    projection: {
      flag: "--fields",
      available: collectProjectionPaths(descriptor.responseSchema),
    },
  };
}

export function findPlatformSchemaPayload(
  descriptors: ReadonlyArray<PlatformOperationDescriptor>,
  method: string,
) {
  const descriptor = descriptors.find(
    (candidate) => toMethodName(candidate.commandPath) === method,
  );

  if (descriptor === undefined) {
    return new PlatformMethodNotFoundError({
      message: `Unknown platform method: ${method}.`,
      suggestion: "Run `supabase platform --help` to inspect the available platform resources.",
    });
  }

  return buildPlatformSchemaPayload(descriptor);
}
