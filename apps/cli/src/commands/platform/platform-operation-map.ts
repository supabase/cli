import type { OperationId } from "@supabase/api/effect";

import { PlatformMetadataError } from "./platform.errors.ts";
import { platformOpenApiOperationEntries } from "./platform-openapi.ts";

type PlatformCommandPath = readonly [string, ...string[]];

const explicitCommandPathOverrides = new Map<OperationId, PlatformCommandPath>([
  ["v1AuthorizeUser", ["platform", "oauth", "authorize"]],
  ["v1OauthAuthorizeProjectClaim", ["platform", "oauth", "project-claim", "authorize"]],
  ["v1BulkCreateSecrets", ["platform", "projects", "secrets", "bulk-create"]],
  ["v1BulkDeleteSecrets", ["platform", "projects", "secrets", "bulk-delete"]],
  ["v1BulkUpdateFunctions", ["platform", "projects", "functions", "bulk-update"]],
  ["v1DiffABranch", ["platform", "branches", "diff"]],
  ["v1ListJitAccess", ["platform", "projects", "database", "jit", "list"]],
  ["v1UpgradePostgresVersion", ["platform", "projects", "upgrade-postgres"]],
]);

const httpMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

function splitWords(value: string): ReadonlyArray<string> {
  return value
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function normalizeCommandSegment(value: string): string {
  return splitWords(value.toLowerCase()).join("-").replaceAll("--", "-");
}

function operationVerbParts(operationId: string): ReadonlyArray<string> {
  return splitWords(operationId)
    .map((part) => part.toLowerCase())
    .filter((part, index) => !(index === 0 && /^v\d+$/.test(part)));
}

function deriveOperationVerbCandidates(operationId: string): ReadonlyArray<string> {
  const parts = operationVerbParts(operationId).filter(
    (part) => part !== "a" && part !== "an" && part !== "the",
  );
  if (parts.length === 0) {
    return ["request"];
  }

  const candidates = new Set<string>();
  const maxLength = Math.min(parts.length, 5);
  for (let index = 1; index <= maxLength; index++) {
    candidates.add(normalizeCommandSegment(parts.slice(0, index).join("-")));
  }
  return [...candidates];
}

function isPathParameter(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

function looksLikeCollection(segment: string): boolean {
  return segment.includes(".") || segment.endsWith("s");
}

function siblingMethodsForPath(path: string): ReadonlyArray<(typeof httpMethods)[number]> {
  return platformOpenApiOperationEntries
    .filter((entry) => entry.path === path)
    .map((entry) => entry.method)
    .sort();
}

function shouldCollapsePostAction(
  entry: (typeof platformOpenApiOperationEntries)[number],
  primaryVerb: string,
): boolean {
  if (entry.method !== "POST") {
    return false;
  }

  const siblingMethods = siblingMethodsForPath(entry.path);
  if (siblingMethods.length !== 1 || siblingMethods[0] !== "POST") {
    return false;
  }

  const segments = entry.path.split("/").filter((segment) => segment.length > 0);
  const lastSegment = segments[segments.length - 1];
  if (
    lastSegment === undefined ||
    isPathParameter(lastSegment) ||
    looksLikeCollection(lastSegment)
  ) {
    return false;
  }

  return normalizeCommandSegment(lastSegment) === primaryVerb;
}

function deriveVerbCandidates(
  entry: (typeof platformOpenApiOperationEntries)[number],
): ReadonlyArray<string> {
  const segments = entry.path.split("/").filter((segment) => segment.length > 0);
  const staticSegments = segments.filter(
    (segment) => !isPathParameter(segment) && segment !== "v1",
  );
  const lastSegment = segments[segments.length - 1];
  const lastStaticSegment = staticSegments[staticSegments.length - 1];
  const candidates = new Set<string>();
  const operationVerbCandidates = deriveOperationVerbCandidates(entry.rawOperationId);

  if (
    lastStaticSegment !== undefined &&
    shouldCollapsePostAction(entry, operationVerbCandidates[0] ?? "request")
  ) {
    candidates.add(normalizeCommandSegment(lastStaticSegment));
  }

  if (entry.method === "GET" && lastSegment !== undefined && !isPathParameter(lastSegment)) {
    if (looksLikeCollection(lastStaticSegment ?? "")) {
      candidates.add("list");
    }
  } else if (entry.method === "HEAD") {
    candidates.add("count");
  }

  for (const candidate of operationVerbCandidates) {
    candidates.add(candidate);
  }

  return [...candidates];
}

function deriveResourceSegments(
  entry: (typeof platformOpenApiOperationEntries)[number],
  verbCandidates: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const segments = entry.path
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "v1" && !isPathParameter(segment))
    .map(normalizeCommandSegment);

  const primaryVerb = verbCandidates[0];
  if (
    primaryVerb !== undefined &&
    shouldCollapsePostAction(entry, primaryVerb) &&
    segments.length > 1
  ) {
    return segments.slice(0, -1);
  }

  return segments;
}

function isPrefixPath(maybePrefix: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean {
  if (maybePrefix.length >= path.length) {
    return false;
  }

  return maybePrefix.every((segment, index) => segment === path[index]);
}

function validateCommandPaths(paths: ReadonlyArray<readonly [OperationId, PlatformCommandPath]>) {
  const seen = new Map<string, OperationId>();
  for (const [operationId, commandPath] of paths) {
    const key = commandPath.join("/");
    const existing = seen.get(key);
    if (existing !== undefined) {
      throw new PlatformMetadataError({
        message: "Duplicate platform command path detected.",
        detail: `${existing} and ${operationId} both resolve to ${commandPath.join(" ")}`,
      });
    }
    seen.set(key, operationId);
  }

  for (const [leftOperationId, leftPath] of paths) {
    for (const [rightOperationId, rightPath] of paths) {
      if (leftOperationId === rightOperationId) {
        continue;
      }
      if (isPrefixPath(leftPath, rightPath)) {
        throw new PlatformMetadataError({
          message: "Platform command path prefix conflict detected.",
          detail: `${leftOperationId} (${leftPath.join(" ")}) prefixes ${rightOperationId} (${rightPath.join(" ")})`,
        });
      }
    }
  }
}

function resolveDerivedCommandPaths(): ReadonlyMap<OperationId, PlatformCommandPath> {
  const resolved = platformOpenApiOperationEntries.map((entry) => {
    const explicit = explicitCommandPathOverrides.get(entry.sdkOperationId);
    if (explicit !== undefined) {
      return [entry.sdkOperationId, explicit] as const;
    }

    const verbCandidates = deriveVerbCandidates(entry);
    const resourceSegments = deriveResourceSegments(entry, verbCandidates);
    const primaryVerb = verbCandidates[0] ?? "request";
    return [
      entry.sdkOperationId,
      ["platform", ...resourceSegments, primaryVerb] as PlatformCommandPath,
    ] as const;
  });

  validateCommandPaths(resolved);
  return new Map(
    [...resolved].sort((left, right) => left[1].join(".").localeCompare(right[1].join("."))),
  );
}

export const platformOperationMap = resolveDerivedCommandPaths();

export function getPlatformCommandPath(operationId: OperationId): PlatformCommandPath {
  const commandPath = platformOperationMap.get(operationId);
  if (commandPath === undefined) {
    throw new PlatformMetadataError({
      message: `No platform command path was found for ${operationId}.`,
    });
  }
  return commandPath;
}
