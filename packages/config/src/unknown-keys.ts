import { Cause, Exit, Option, Schema, type SchemaIssue } from "effect";
import { CliConfigSchema, RemotesSchema } from "./base.ts";
import { cliConfigSchemaKey, isObject } from "./config-document.ts";

const parseOptions = { onExcessProperty: "error", errors: "all", disableChecks: true } as const;
const decodeCliConfig = Schema.decodeUnknownExit(CliConfigSchema, parseOptions);
const decodeRemotes = Schema.decodeUnknownExit(RemotesSchema, parseOptions);

type KeyPath = ReadonlyArray<string>;

const SEPARATOR = "\u0000";
const encodePath = (path: KeyPath): string => path.join(SEPARATOR);

type KnownKeys = ReadonlyArray<string>;
type Found = Map<string, KnownKeys>;

/** A union reports a key only when every member that rejected the value flagged it. */
const intersect = (founds: ReadonlyArray<Found>): Found => {
  const [first, ...rest] = founds;
  return new Map([...(first ?? [])].filter(([key]) => rest.every((found) => found.has(key))));
};

const collect = (issue: SchemaIssue.Issue, prefix: KeyPath, known: KnownKeys): Found => {
  switch (issue._tag) {
    case "Pointer":
      return collect(issue.issue, [...prefix, ...issue.path.map(String)], known);
    case "Composite": {
      const siblings =
        issue.ast._tag === "Objects"
          ? issue.ast.propertySignatures.map((signature) => String(signature.name))
          : [];
      return new Map(issue.issues.flatMap((child) => [...collect(child, prefix, siblings)]));
    }
    case "AnyOf":
      return intersect(issue.issues.map((child) => collect(child, prefix, known)));
    case "Encoding":
    case "Filter":
      return collect(issue.issue, prefix, known);
    case "UnexpectedKey":
      return new Map([[encodePath(prefix), known]]);
    default:
      return new Map();
  }
};

const unknownKeysOf = (exit: Exit.Exit<unknown, Schema.SchemaError>, prefix: KeyPath): Found => {
  if (Exit.isSuccess(exit)) return new Map();
  const error = Cause.findErrorOption(exit.cause);
  return Option.isSome(error) ? collect(error.value.issue, prefix, []) : new Map();
};

/** An unknown key's path plus the keys its parent table accepts. */
export interface UnknownCliConfigKey {
  readonly path: KeyPath;
  readonly knownKeys: ReadonlyArray<string>;
}

/**
 * Unknown keys in a raw config document that `CliConfigSchema` does not accept, remote blocks under
 * `["remotes", <name>, ...]`. Pass a document already normalized for deprecated keys.
 */
export function findUnknownCliConfigKeys(document: unknown): ReadonlyArray<UnknownCliConfigKey> {
  if (!isObject(document)) return [];
  const { [cliConfigSchemaKey]: _schemaKey, remotes, ...base } = document;
  const keys = unknownKeysOf(decodeCliConfig({ ...base, remotes: {} }), []);
  const remoteKeys = unknownKeysOf(decodeRemotes(remotes ?? {}), ["remotes"]);
  return [...keys, ...remoteKeys]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([encoded, knownKeys]) => ({ path: encoded.split(SEPARATOR), knownKeys }));
}
