import { Cause, Exit, Option, Schema, type SchemaIssue } from "effect";
import { CliConfigSchema, RemotesSchema } from "./base.ts";
import { cliConfigSchemaKey, isObject } from "./config-document.ts";

const parseOptions = { onExcessProperty: "error", errors: "all", disableChecks: true } as const;
const decodeCliConfig = Schema.decodeUnknownExit(CliConfigSchema, parseOptions);
const decodeRemotes = Schema.decodeUnknownExit(RemotesSchema, parseOptions);

type KeyPath = ReadonlyArray<string>;

const SEPARATOR = "\u0000";
const encodePath = (path: KeyPath): string => path.join(SEPARATOR);

/** A union reports a key only when every member that rejected the value flagged it. */
const intersect = (sets: ReadonlyArray<Set<string>>): Set<string> => {
  const [first, ...rest] = sets;
  return new Set([...(first ?? [])].filter((key) => rest.every((set) => set.has(key))));
};

const collect = (issue: SchemaIssue.Issue, prefix: KeyPath): Set<string> => {
  switch (issue._tag) {
    case "Pointer":
      return collect(issue.issue, [...prefix, ...issue.path.map(String)]);
    case "Composite":
      return new Set(issue.issues.flatMap((child) => [...collect(child, prefix)]));
    case "AnyOf":
      return intersect(issue.issues.map((child) => collect(child, prefix)));
    case "Encoding":
    case "Filter":
      return collect(issue.issue, prefix);
    case "UnexpectedKey":
      return new Set([encodePath(prefix)]);
    default:
      return new Set();
  }
};

const unknownKeysOf = (exit: Exit.Exit<unknown, Schema.SchemaError>, prefix: KeyPath) => {
  if (Exit.isSuccess(exit)) return new Set<string>();
  const error = Cause.findErrorOption(exit.cause);
  return Option.isSome(error) ? collect(error.value.issue, prefix) : new Set<string>();
};

/**
 * Key paths in a raw config document that `CliConfigSchema` does not accept, remote blocks under
 * `["remotes", <name>, ...]`. Pass a document already normalized for deprecated keys.
 */
export function findUnknownCliConfigKeys(document: unknown): ReadonlyArray<KeyPath> {
  if (!isObject(document)) return [];
  const { [cliConfigSchemaKey]: _schemaKey, remotes, ...base } = document;
  const keys = unknownKeysOf(decodeCliConfig({ ...base, remotes: {} }), []);
  const remoteKeys = unknownKeysOf(decodeRemotes(remotes ?? {}), ["remotes"]);
  return [...keys, ...remoteKeys].sort().map((encoded) => encoded.split(SEPARATOR));
}
