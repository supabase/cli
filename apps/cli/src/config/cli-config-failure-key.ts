import {
  CliConfigSchema,
  type CliConfigParseError,
  type CliConfigRemovedKeyError,
} from "@supabase/config";
import { Predicate, Schema, type SchemaIssue } from "effect";

import { cliConfigDocumentOnlyPaths, cliConfigRegistry } from "./cli-config-keys.ts";
import type { CliConfigValueError } from "./cli-config.errors.ts";

const REMOVED_KEY_PATHS: ReadonlyArray<string> = [
  "inbucket",
  "experimental.orioledb_version",
  "auth.external.linkedin",
  "auth.external.slack",
];

const withAncestors = (path: string): ReadonlyArray<string> => {
  const segments = path.split(".");
  return segments.map((_, index) => segments.slice(0, index + 1).join("."));
};

const KNOWN_PATHS: ReadonlySet<string> = new Set(
  [
    ...Object.keys(CliConfigSchema.fields),
    ...cliConfigRegistry.keys.map((key) => key.path),
    ...cliConfigRegistry.families.map((family) => family.prefix),
    ...cliConfigDocumentOnlyPaths,
  ].flatMap(withAncestors),
);

const taggedAs =
  <E extends { readonly _tag: string }>(tag: E["_tag"]) =>
  (error: unknown): error is E =>
    Predicate.isTagged(error, tag);

const isRemovedKeyError = taggedAs<CliConfigRemovedKeyError>("CliConfigRemovedKeyError");
const isParseError = taggedAs<CliConfigParseError>("CliConfigParseError");
const isValueError = taggedAs<CliConfigValueError>("CliConfigValueError");

const removedKeyPath = (displayKey: string): string | undefined => {
  const path = displayKey.replaceAll(/[[\]]/g, "");
  return REMOVED_KEY_PATHS.find(
    (canonical) =>
      path === canonical || (path.startsWith("remotes.") && path.endsWith(`.${canonical}`)),
  );
};

const knownPrefix = (segments: ReadonlyArray<string>): string | undefined => {
  for (let length = segments.length; length > 0; length--) {
    const candidate = segments.slice(0, length).join(".");
    if (KNOWN_PATHS.has(candidate)) return candidate;
  }
  return undefined;
};

/** Remote blocks decode as one record, so their issue paths start with the remote name instead of `remotes`. */
const decodedAsRemoteBlocks = (issue: SchemaIssue.Issue): boolean =>
  issue._tag === "Composite" &&
  issue.ast._tag === "Objects" &&
  issue.ast.propertySignatures.length === 0;

const firstIssuePath = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined => {
  switch (issue._tag) {
    case "Pointer":
      return firstIssuePath(issue.issue, [...path, ...issue.path.map(String)]);
    case "Filter":
    case "Encoding":
      return firstIssuePath(issue.issue, path);
    case "Composite":
    case "AnyOf":
      for (const nested of issue.issues) {
        const found = firstIssuePath(nested, path);
        if (found !== undefined) return found;
      }
      return undefined;
    default:
      return path.length > 0 ? path : undefined;
  }
};

/** The source-owned config key path a config load failure names, never a value, file path or user-chosen name. */
export const cliConfigFailureKey = (error: unknown): string | undefined => {
  if (isRemovedKeyError(error)) {
    const matched = new Set<string>();
    for (const { key } of error.removedKeys) {
      const canonical = removedKeyPath(key);
      if (canonical !== undefined) matched.add(canonical);
    }
    return matched.size === 0 ? undefined : [...matched].sort().join(",");
  }
  if (isValueError(error)) {
    return knownPrefix(error.path.split("."));
  }
  if (isParseError(error) && Schema.isSchemaError(error.cause)) {
    const { issue } = error.cause;
    const path = firstIssuePath(issue, []);
    if (path === undefined) return undefined;
    return knownPrefix(decodedAsRemoteBlocks(issue) ? path.slice(1) : path);
  }
  return undefined;
};
