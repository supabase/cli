import { operationDefinitions } from "@supabase/api/effect";
import { Effect, FileSystem, Option, Predicate, Schema, type SchemaIssue } from "effect";

import { Stdin } from "../../shared/runtime/stdin.service.ts";
import type { ApiFlagValue } from "./api-command-flags.ts";
import { readPointer, writePointer } from "./api-command-pointer.ts";
import { ApiCommandUsageError } from "../../command-internal/command-errors/api-command.errors.ts";
import type { ApiCommandEntry } from "./api-command.model.ts";

/** Parsed flag values keyed by flag name; `None` means the flag was absent. */
export type ApiFlagValues = Readonly<Record<string, Option.Option<ApiFlagValue>>>;

const REDACTED_PREVIEW_VALUE = "[redacted]";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  Predicate.isObject(value) && !Array.isArray(value);

/** The operation's typed definition; the entry names it as a key of `operationDefinitions`. */
export const definitionOf = (entry: Pick<ApiCommandEntry, "definition">) =>
  operationDefinitions[entry.definition];

const parseBodyText = Effect.fnUntraced(function* (text: string, source: string) {
  const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(
      () =>
        new ApiCommandUsageError({
          message: `${source} is not valid JSON.`,
          hint: "Pass the whole request body as one JSON object.",
        }),
    ),
  );
  if (!isRecord(parsed)) {
    return yield* new ApiCommandUsageError({
      message: `${source} must be a JSON object.`,
      hint: "Pass the whole request body as one JSON object.",
    });
  }
  return parsed;
});

/** Reads the whole-body override from `--body` (JSON text) or `--file` (a JSON file, `-` for stdin). */
export const readBodyOverride = Effect.fn("api-command.read-body")(function* (input: {
  readonly body: Option.Option<string>;
  readonly file: Option.Option<string>;
}) {
  if (Option.isSome(input.body) && Option.isSome(input.file)) {
    return yield* new ApiCommandUsageError({
      message: "--body and --file cannot be used together.",
      hint: "Pass the request body with one of them.",
    });
  }
  if (Option.isSome(input.body)) {
    return Option.some(yield* parseBodyText(input.body.value, "--body"));
  }
  if (Option.isSome(input.file)) {
    const path = input.file.value;
    if (path === "-") {
      const stdin = yield* Stdin;
      const piped = yield* stdin.readPipedText;
      if (Option.isNone(piped)) {
        return yield* new ApiCommandUsageError({
          message: "--file - found no body on stdin.",
          hint: "Pipe the request body into the command, or pass --body.",
        });
      }
      return Option.some(yield* parseBodyText(piped.value, "--file -"));
    }
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(
      Effect.mapError(
        () =>
          new ApiCommandUsageError({
            message: `Cannot read the --file body at ${path}.`,
            hint: "Check that the file exists and is readable.",
          }),
      ),
    );
    return Option.some(yield* parseBodyText(text, `--file ${path}`));
  }
  return Option.none<Readonly<Record<string, unknown>>>();
});

const initialBody = (entry: ApiCommandEntry): Readonly<Record<string, unknown>> | undefined => {
  if (entry.body === undefined) return undefined;
  if (entry.body.kind === "json-envelope") {
    return { data: { type: entry.body.type, attributes: {} } };
  }
  return {};
};

const parseJsonFlag = (flag: string, text: ApiFlagValue) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(
      () =>
        new ApiCommandUsageError({
          message: `--${flag} is not valid JSON.`,
          hint: `Pass a JSON value and quote it for the shell, e.g. --${flag} '{"key":"value"}'.`,
        }),
    ),
  );

/**
 * The flat operation input `{...bodyFields, ...query, ...headers, ref, <path parameter>}`. A body
 * override is the starting point when given, else the synthesized envelope; only flags that were
 * passed are written, each at its own pointer. An override may only carry top-level fields the
 * request body declares, and the path values are applied last so body data cannot retarget the
 * request.
 */
export const assembleInput = Effect.fnUntraced(function* (
  entry: ApiCommandEntry,
  ref: string,
  flagValues: ApiFlagValues,
  bodyOverride: Option.Option<Readonly<Record<string, unknown>>>,
  argument?: string,
) {
  if (Option.isSome(bodyOverride)) {
    const { requestBody } = definitionOf(entry);
    const declared: ReadonlyArray<string> = requestBody.kind === "json" ? requestBody.fields : [];
    const unknown = Object.keys(bodyOverride.value).find((key) => !declared.includes(key));
    if (unknown !== undefined) {
      return yield* new ApiCommandUsageError({
        message: `--body/--file has the field "${unknown}", which the request body does not take.`,
        hint:
          declared.length === 0
            ? "This command takes no request body."
            : `Top-level fields: ${declared.join(", ")}.`,
      });
    }
  }
  const jsonFlagNames = new Set(
    entry.flags.filter((flag) => flag.type === "json").map((flag) => flag.name),
  );
  let body: unknown = Option.getOrElse(bodyOverride, () => initialBody(entry));
  const query: Record<string, unknown> = {};
  const headers: Record<string, unknown> = {};
  const positional: Record<string, unknown> = {};
  for (const binding of entry.bindings) {
    if (binding.source === "argument") {
      if (argument !== undefined) {
        if (argument === "" || argument === "." || argument === "..") {
          return yield* new ApiCommandUsageError({
            message: `<${binding.argument}> must not be empty, "." or "..".`,
            hint: "Pass the identifier of the resource.",
          });
        }
        positional[binding.name] = argument;
      }
      continue;
    }
    if (binding.source !== "flag") continue;
    const value = flagValues[binding.flag];
    if (value === undefined || Option.isNone(value)) continue;
    if (binding.location === "query") query[binding.name] = value.value;
    if (binding.location === "header") headers[binding.name] = value.value;
    if (binding.location === "body") {
      const parsed = jsonFlagNames.has(binding.flag)
        ? yield* parseJsonFlag(binding.flag, value.value)
        : value.value;
      body = writePointer(body, binding.pointer, parsed);
    }
  }
  return { ...(isRecord(body) ? body : {}), ...query, ...headers, ref, ...positional };
});

type Path = ReadonlyArray<PropertyKey>;

/** Input fields of which a request needs at least one; a single path means that field is required. */
type Requirement = ReadonlyArray<Path>;

const pathKey = (path: Path) => path.map(String).join("/");

/**
 * Requirements an issue tree reports missing: every required key is one requirement, and a union
 * whose branches each miss one key is one requirement of alternatives. `undefined` when the tree
 * holds any other failure.
 */
const missingKeyPaths = (
  issue: SchemaIssue.Issue,
  path: Path,
): ReadonlyArray<Requirement> | undefined => {
  switch (issue._tag) {
    case "MissingKey":
      return [[path]];
    case "Pointer":
      return missingKeyPaths(issue.issue, [...path, ...issue.path]);
    case "Filter":
    case "Encoding":
      return missingKeyPaths(issue.issue, path);
    case "Composite": {
      const requirements: Requirement[] = [];
      for (const child of issue.issues) {
        const childRequirements = missingKeyPaths(child, path);
        if (childRequirements === undefined) return undefined;
        requirements.push(...childRequirements);
      }
      return requirements.length === 0 ? undefined : requirements;
    }
    case "AnyOf": {
      const alternatives = new Map<string, Path>();
      for (const child of issue.issues) {
        const childRequirements = missingKeyPaths(child, path);
        if (childRequirements?.length !== 1) return undefined;
        for (const alternative of childRequirements[0]!) {
          alternatives.set(pathKey(alternative), alternative);
        }
      }
      return alternatives.size === 0 ? undefined : [[...alternatives.values()]];
    }
    default:
      return undefined;
  }
};

/** The flag binding that supplies the input field at `path`, if one covers it. */
const flagAt = (entry: ApiCommandEntry, path: Path) => {
  const pointer = `/${path.map(String).join("/")}`;
  for (const binding of entry.bindings) {
    if (binding.source !== "flag") continue;
    if (binding.location === "body" && binding.pointer === pointer) return binding;
    if (
      (binding.location === "query" || binding.location === "header") &&
      path.length === 1 &&
      path[0] === binding.name
    ) {
      return binding;
    }
  }
  return undefined;
};

const invalidRequest = (entry: ApiCommandEntry, error: Schema.SchemaError) => {
  const requirements = missingKeyPaths(error.issue, []);
  const alternatives = requirements?.length === 1 ? requirements[0]! : undefined;
  if (alternatives !== undefined && alternatives.length > 1) {
    const bindings = alternatives.map((path) => flagAt(entry, path));
    if (bindings.every((binding) => binding !== undefined)) {
      const names = bindings.map((binding) => `--${binding.flag}`).join(", ");
      return new ApiCommandUsageError({
        message: `Pass at least one of ${names}`,
        hint: bindings.every((binding) => binding.location === "body")
          ? "Pass one of the flags, or include one of the fields in --body/--file."
          : "Pass one of the flags.",
      });
    }
  }
  const paths = requirements?.every((requirement) => requirement.length === 1)
    ? requirements.map((requirement) => requirement[0]!)
    : undefined;
  const missing = paths?.map((path) => flagAt(entry, path));
  if (missing !== undefined && missing.every((binding) => binding !== undefined)) {
    const names = missing.map((binding) => `--${binding.flag}`).join(", ");
    const plural = missing.length === 1 ? "" : "s";
    const allBody = missing.every((binding) => binding.location === "body");
    return new ApiCommandUsageError({
      message: `Missing required flag${plural} ${names}`,
      hint: allBody
        ? `Pass the flag${plural}, or include the field${plural} in --body/--file.`
        : `Pass the flag${plural}.`,
    });
  }
  return new ApiCommandUsageError({
    message: `The request is not valid: ${error.message}`,
    hint: "Check the flags, or the --body/--file contents.",
  });
};

/**
 * Decodes an assembled input with the operation's input schema, rejecting unknown keys, so a
 * request that cannot be formed fails before consent or any network call.
 */
export const decodeInput = (entry: ApiCommandEntry, input: unknown) =>
  Schema.decodeUnknownEffect(definitionOf(entry).inputSchema, { onExcessProperty: "error" })(
    input,
  ).pipe(Effect.mapError((error) => invalidRequest(entry, error)));

/** What a request would send: method, path, query, headers and body, with sensitive flag values masked. */
export interface ApiRequestPreview {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly body: unknown;
}

const pick = (source: object, keys: ReadonlyArray<string>): Record<string, unknown> => {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const value: unknown = Reflect.get(source, key);
    if (value !== undefined) picked[key] = value;
  }
  return picked;
};

/** Describes the request a decoded input would send. */
export const previewRequest = (entry: ApiCommandEntry, decoded: object): ApiRequestPreview => {
  const definition = definitionOf(entry);
  const path = definition.pathParams.reduce<string>(
    (current, name) =>
      current.replace(`{${name}}`, encodeURIComponent(String(Reflect.get(decoded, name)))),
    definition.path,
  );
  const sensitive = new Set(entry.flags.filter((flag) => flag.sensitive).map((flag) => flag.name));
  let body: unknown = null;
  if (definition.requestBody.kind === "json") {
    body = pick(decoded, definition.requestBody.fields);
    for (const binding of entry.bindings) {
      if (binding.location !== "body" || !sensitive.has(binding.flag)) continue;
      if (readPointer(body, binding.pointer) !== undefined) {
        body = writePointer(body, binding.pointer, REDACTED_PREVIEW_VALUE);
      }
    }
  }
  return {
    method: definition.method,
    path,
    query: pick(decoded, definition.queryParams),
    headers: pick(decoded, definition.headerParams),
    body,
  };
};
