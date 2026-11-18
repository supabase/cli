import { Effect, Option, Predicate, Schema } from "effect";
import { Command, CommandSpec } from "effect/cli";

import { readApiCommand } from "../../commands/api/api-command.annotation.ts";
import type {
  ApiCommandBinding,
  ApiCommandEntry,
  ApiCommandFlag,
  ApiCommandSchemas,
} from "../../commands/api/api-command.model.ts";
import { readCommandStage } from "../../command-internal/command-stage/command-stage.annotation.ts";
import type { CommandStage } from "../../command-internal/command-stage/command-stage.annotation.ts";
import { nouns } from "../../commands/api/api-command-policy.ts";
import { apiCommands } from "../../commands/api/generated.ts";
import { rootCommandForFeatures } from "../root.ts";
import { flattenSubcommands } from "../../docs/docs-introspection.ts";
import { readCommandErrorsContract } from "../../command-internal/command-errors/command-errors.annotation.ts";
import { readPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import type { CommandPermissions } from "../../command-internal/command-permissions/model.ts";
import { readTargetPolicy } from "../../command-internal/target/target-policy.ts";
import type { TargetGroup } from "../../command-internal/target/target-policy.ts";

type JsonSchema = Readonly<Record<string, unknown>>;

/** A positional argument as the parser accepts it. */
interface SurfaceArgument {
  readonly name: string;
  readonly type: string;
  readonly choices: readonly string[] | null;
  readonly required: boolean;
  readonly variadic: boolean;
}

/**
 * A flag as the parser accepts it, except that a generated API flag is `required` and `sensitive`
 * as its operation declares; `env` is `null` because the parser carries no env name.
 */
interface SurfaceFlag {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly type: string;
  readonly choices: readonly string[] | null;
  readonly required: boolean;
  readonly default: unknown;
  readonly env: string | null;
  readonly negatable: boolean;
  readonly variadic: boolean;
  readonly hidden: boolean;
  readonly sensitive: boolean;
}

/** What a generated command declares about the Management API operation it calls. */
interface SurfaceApi {
  readonly operationId: string;
  /** Request body content type and JSON Schema, `null` when the operation sends none. */
  readonly request: { readonly contentType: string; readonly schema: unknown } | null;
  readonly bindings: readonly ApiCommandBinding[];
}

/** One command or group of the mounted tree. Optional fields are omitted when the command declares nothing. */
interface CommandSurfaceEntry {
  readonly path: readonly string[];
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly unlisted: boolean;
  readonly stage?: CommandStage;
  readonly target?: { readonly group: TargetGroup; readonly consent: "none" | "no" | "yes" };
  readonly permissions?: CommandPermissions;
  readonly arguments: readonly SurfaceArgument[];
  readonly flags: Readonly<Record<string, SurfaceFlag>>;
  /** `"undeclared"` for a hand-written command, else a JSON Schema `anyOf` of titled branches. */
  readonly result: "undeclared" | JsonSchema;
  readonly errors: "standard" | "legacy";
  readonly api?: SurfaceApi;
}

/** The default tree plus the entries each feature variant adds or changes. */
interface CommandSurface {
  readonly globalFlags: Readonly<Record<string, SurfaceFlag>>;
  readonly commands: Readonly<Record<string, CommandSurfaceEntry>>;
  readonly variants: Readonly<Record<string, Readonly<Record<string, CommandSurfaceEntry>>>>;
}

type CommandRoot = Command.Command.Any;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const generatedEntries: readonly ApiCommandEntry[] = apiCommands;

const dryRunSchema: JsonSchema = {
  title: "dryRun",
  type: "object",
  properties: {
    method: { type: "string" },
    path: { type: "string" },
    query: { type: "object" },
    headers: { type: "object" },
    body: {},
  },
  required: ["method", "path", "query", "headers", "body"],
  additionalProperties: false,
};

// The schema table is the heavy generated module; importing it on demand keeps it out of the
// command runtime's module graph.
const loadSchemaTable = Effect.fn("CommandSurface.loadSchemas")(function* () {
  const loaded = yield* Effect.promise(() => import("../../commands/api/generated.schemas.ts"));
  const table: Readonly<Record<string, ApiCommandSchemas | undefined>> = loaded.apiCommandSchemas;
  return table;
});

const titled = (schema: unknown, title: string): JsonSchema =>
  Predicate.isObject(schema) ? { ...schema, title } : { title, allOf: [schema] };

const jsonOf = (value: unknown): unknown =>
  Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)
    ? value
    : Array.isArray(value)
      ? value.map(jsonOf)
      : null;

const choicesOf = (type: CommandSpec.Type): readonly string[] | null =>
  type._tag === "Choice" ? type.values : null;

const defaultOf = (fallbacks: ReadonlyArray<CommandSpec.Fallback>): unknown => {
  const found = fallbacks.find((fallback) => fallback._tag === "Default");
  return found === undefined ? null : jsonOf(found.value);
};

const findCommand = (root: CommandRoot, path: readonly string[]): Option.Option<CommandRoot> =>
  path.reduce<Option.Option<CommandRoot>>(
    (current, segment) =>
      Option.flatMap(current, (command) =>
        Option.fromUndefinedOr(flattenSubcommands(command).find((child) => child.name === segment)),
      ),
    Option.some(root),
  );

const collectPaths = (
  command: CommandRoot,
  prefix: readonly string[],
): ReadonlyArray<readonly string[]> =>
  flattenSubcommands(command).flatMap((child) => {
    const path = [...prefix, child.name];
    return [path, ...collectPaths(child, path)];
  });

const sortedRecord = <A>(
  entries: ReadonlyArray<readonly [string, A]>,
): Readonly<Record<string, A>> =>
  Object.fromEntries([...entries].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const noApiFlags: ReadonlyMap<string, ApiCommandFlag> = new Map();

const surfaceFlag = (
  flag: CommandSpec.Flag,
  apiFlags: ReadonlyMap<string, ApiCommandFlag>,
): readonly [string, SurfaceFlag] => [
  flag.name,
  {
    name: flag.name,
    aliases: flag.aliases,
    type: flag.typeName,
    choices: choicesOf(flag.type),
    required: flag.required || apiFlags.get(flag.name)?.required === true,
    default: defaultOf(flag.fallbacks),
    env: null,
    negatable: flag.negation !== undefined,
    variadic: flag.variadic !== undefined,
    hidden: flag.hidden,
    sensitive: flag.type._tag === "Redacted" || apiFlags.get(flag.name)?.sensitive === true,
  },
];

/** The Global-scope flags every command accepts, keyed by name in sorted order. */
const walkGlobalFlags = (root: CommandRoot) => {
  const spec = CommandSpec.resolve(root, [root.name]);
  return sortedRecord(
    Option.isNone(spec)
      ? []
      : spec.value.flags
          .filter((flag) => flag.scope._tag === "Global")
          .map((flag) => surfaceFlag(flag, noApiFlags)),
  );
};

const apiSurface = Effect.fn("CommandSurface.api")(function* (command: CommandRoot) {
  const descriptor = readApiCommand(command);
  if (Option.isNone(descriptor)) return Option.none();
  const { operationId, bindings } = descriptor.value;
  const generated = generatedEntries.find((entry) => entry.operationId === operationId);
  if (generated === undefined) {
    return yield* Effect.die(`no generated command declares operation "${operationId}"`);
  }
  const table = yield* loadSchemaTable();
  const schemas = table[operationId];
  if (schemas === undefined) {
    return yield* Effect.die(`no generated schemas for operation "${operationId}"`);
  }
  const waitRead = generated.wait?.read === operationId ? undefined : generated.wait?.read;
  const waitSchemas = waitRead === undefined ? undefined : table[waitRead];
  if (waitRead !== undefined && waitSchemas === undefined) {
    return yield* Effect.die(`no generated schemas for operation "${waitRead}"`);
  }
  const branches = [
    titled(schemas.result, "response"),
    ...(waitSchemas === undefined ? [] : [titled(waitSchemas.result, "waited")]),
    dryRunSchema,
  ];
  return Option.some({
    api: {
      operationId,
      request:
        schemas.request === undefined
          ? null
          : { contentType: schemas.request.contentType, schema: schemas.request.schema },
      bindings,
    } satisfies SurfaceApi,
    result: { anyOf: branches } satisfies JsonSchema,
    apiFlags: new Map(generated.flags.map((flag) => [flag.name, flag])),
  });
});

/** Extracts the surface of the command at `path` (root name omitted) from the mounted tree `root`. */
export const commandSurfaceEntry = Effect.fn("CommandSurface.entry")(function* (
  root: CommandRoot,
  path: readonly string[],
) {
  const command = findCommand(root, path);
  const spec = CommandSpec.resolve(root, [root.name, ...path]);
  if (Option.isNone(command) || Option.isNone(spec)) {
    return yield* Effect.die(`unknown command path "${path.join(" ")}"`);
  }
  const api = yield* apiSurface(command.value);
  const apiFlags = Option.match(api, {
    onNone: () => noApiFlags,
    onSome: (found) => found.apiFlags,
  });
  const stage = readCommandStage(command.value);
  const target = readTargetPolicy(command.value);
  const permissions = readPermissions(command.value);
  const flags = spec.value.flags
    .filter((flag) => flag.scope._tag !== "Global")
    .map((flag) => surfaceFlag(flag, apiFlags));
  const entry: CommandSurfaceEntry = {
    path,
    aliases: spec.value.alias === undefined ? [] : [spec.value.alias],
    summary: spec.value.shortDescription ?? spec.value.description ?? "",
    unlisted: spec.value.unlisted,
    ...(Option.isSome(stage) ? { stage: stage.value } : {}),
    ...(Option.isSome(target)
      ? { target: { group: target.value.group, consent: target.value.consent } }
      : {}),
    ...(Option.isSome(permissions) ? { permissions: permissions.value } : {}),
    arguments: spec.value.arguments.map((argument) => ({
      name: argument.name,
      type: argument.typeName,
      choices: choicesOf(argument.type),
      required: argument.required,
      variadic: argument.variadic !== undefined,
    })),
    flags: sortedRecord(flags),
    result: Option.isSome(api) ? api.value.result : "undeclared",
    errors: readCommandErrorsContract(command.value),
    ...(Option.isSome(api) ? { api: api.value.api } : {}),
  };
  return entry;
});

/** Extracts every command and group of `root`, keyed by space-joined path in sorted order. */
export const walkCommandSurface = Effect.fn("CommandSurface.walk")(function* (root: CommandRoot) {
  const paths = collectPaths(root, []);
  const entries = yield* Effect.forEach(paths, (path) =>
    Effect.map(commandSurfaceEntry(root, path), (entry) => [path.join(" "), entry] as const),
  );
  return sortedRecord(entries);
});

/** The default command surface and, per feature, the entries that differ when the feature is on. */
export const commandSurface = Effect.fn("CommandSurface.build")(function* () {
  const base = yield* walkCommandSurface(rootCommandForFeatures());
  const features = [...new Set(Object.values(nouns).map(({ feature }) => feature))];
  const variants = yield* Effect.forEach(features, (feature) =>
    Effect.gen(function* () {
      const walked = yield* walkCommandSurface(rootCommandForFeatures({ apiFeatures: [feature] }));
      const differing = Object.entries(walked).filter(
        ([key, entry]) => key in base === false || encodeJson(base[key]) !== encodeJson(entry),
      );
      return [feature, sortedRecord(differing)] as const;
    }),
  );
  return {
    globalFlags: walkGlobalFlags(rootCommandForFeatures()),
    commands: base,
    variants: sortedRecord(variants),
  } satisfies CommandSurface;
});
