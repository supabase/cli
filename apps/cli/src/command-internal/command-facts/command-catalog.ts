import { operationPermissions } from "@supabase/api/permissions";
import { Effect, Option } from "effect";
import type { Command } from "effect/cli";

import { commandInternals, flattenSubcommands } from "../../docs/docs-introspection.ts";
import { docsFlagDoc } from "../../docs/docs-spec.ts";
import type { DocsFlag } from "../../docs/docs-spec.ts";
import { readPermissions } from "../command-permissions/command-permissions.annotation.ts";
import type { FactCheck } from "./command-fact.ts";
import { COMMAND_FACTS } from "./command-facts.registry.ts";

/** One registered fact as it appears in the catalog. */
export interface CatalogFact {
  readonly checked: ReadonlyArray<FactCheck>;
  readonly value: unknown;
}

/** Agent-facing traits with the names `effect/ai/Tool` uses for its annotations. */
export interface CatalogTraits {
  readonly readonly: boolean;
  readonly destructive: boolean;
}

/** A command's public surface: Effect's own fields plus every registered fact present on it. */
export interface CatalogEntry {
  readonly path: ReadonlyArray<string>;
  readonly description: string | undefined;
  readonly shortDescription: string | undefined;
  readonly unlisted: boolean;
  readonly examples: ReadonlyArray<Command.Command.Example>;
  readonly flags: ReadonlyArray<DocsFlag>;
  readonly globalFlags: ReadonlyArray<string>;
  readonly traits: CatalogTraits | undefined;
  readonly facts: Readonly<Record<string, CatalogFact>>;
}

/**
 * Derives `Tool.Readonly` and `Tool.Destructive` from declared permissions: read-only when every
 * operation's OAuth scope is a read scope, destructive when a required operation needs a delete
 * permission. Undefined for commands without mapped permissions.
 */
const traitsOf = (command: Command.Command.Any): CatalogTraits | undefined => {
  const permissions = Option.getOrUndefined(readPermissions(command));
  if (permissions === undefined || permissions.status !== "mapped") return undefined;
  const scopes = permissions.operations.map(
    (entry) => operationPermissions[entry.operationId]?.oauthScope,
  );
  return {
    readonly: scopes.every((scope) => scope?.endsWith(":read") === true),
    destructive: permissions.operations.some(
      (entry) =>
        entry.kind === "required" &&
        (operationPermissions[entry.operationId]?.fga ?? []).some((set) =>
          set.some((permission) => permission.endsWith("_delete")),
        ),
    ),
  };
};

const entryFor = Effect.fnUntraced(function* (
  command: Command.Command.Any,
  path: ReadonlyArray<string>,
) {
  const facts: Record<string, CatalogFact> = {};
  for (const fact of COMMAND_FACTS) {
    const read = fact.read(command);
    if (Option.isSome(read)) facts[fact.id] = { checked: fact.checked, value: yield* read.value };
  }
  const internals = commandInternals(command);
  return {
    path,
    description: command.description,
    shortDescription: command.shortDescription,
    unlisted: command.unlisted,
    examples: command.examples,
    flags: internals.config.flags.flatMap((flag) => docsFlagDoc(path, flag) ?? []),
    globalFlags: internals.globalFlags
      .map((entry) => entry.flag)
      .flatMap((flag) => {
        const doc = docsFlagDoc(path, flag);
        return doc === undefined ? [] : [doc.id];
      }),
    traits: traitsOf(command),
    facts,
  } satisfies CatalogEntry;
});

const entriesFor = (
  command: Command.Command.Any,
  path: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<CatalogEntry>> =>
  Effect.gen(function* () {
    const entry = yield* entryFor(command, path);
    const children = yield* Effect.forEach(flattenSubcommands(command), (child) =>
      entriesFor(child, [...path, child.name]),
    );
    return [entry, ...children.flat()];
  });

/** Walks the command tree and returns one entry per command, root first. */
export const commandCatalog = Effect.fn("CommandCatalog.build")(function* (
  root: Command.Command.Any,
) {
  const entries = yield* entriesFor(root, []);
  yield* Effect.annotateCurrentSpan("catalog.entries", entries.length);
  return entries;
});

/** Annotation ids present on any command in the tree. */
export const annotationIds = (root: Command.Command.Any): ReadonlySet<string> => {
  const ids = new Set<string>();
  const visit = (command: Command.Command.Any) => {
    for (const key of command.annotations.mapUnsafe.keys()) ids.add(key);
    flattenSubcommands(command).forEach(visit);
  };
  visit(root);
  return ids;
};
