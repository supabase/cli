import { Context, Option } from "effect";
import type { HelpDoc, Param } from "effect/cli";

import { choiceKeysOf } from "../../docs/docs-introspection.ts";
import { ROOT_GLOBAL_FLAGS } from "../global-flags.ts";
import { unwrapParam } from "../param-introspection.ts";

/** What a permission condition needs to know about a flag: its value shape and whether help shows it. */
export interface PermissionFlag {
  readonly name: string;
  readonly kind: "boolean" | "choice" | "text";
  readonly hidden: boolean;
  /** The accepted values of a `choice` flag; empty otherwise. */
  readonly choices: ReadonlyArray<string>;
  /** Declared with `Flag.optional` outermost, so it can be unset; a flag with a default is not. */
  readonly optional: boolean;
}

/** The flags a command accepts, by name. */
export type FlagCatalog = ReadonlyMap<string, PermissionFlag>;

/**
 * Context key under which {@link withPermissions} stores a function that reads the annotated
 * command's own flags, so the command's internals are inspected only when help is rendered.
 */
export class CommandFlagsAnnotation extends Context.Service<
  CommandFlagsAnnotation,
  () => ReadonlyArray<PermissionFlag>
>()("supabase/CommandFlags") {}

export function permissionFlagsOf(
  params: ReadonlyArray<Param.AnyFlag>,
): ReadonlyArray<PermissionFlag> {
  return params.flatMap((param) => {
    const single = unwrapParam(param)?.single;
    if (single === undefined) return [];
    const choices = choiceKeysOf(single.primitiveType);
    const kind =
      single.primitiveType._tag === "Boolean"
        ? "boolean"
        : choices === undefined
          ? "text"
          : "choice";
    return [
      {
        name: single.name,
        kind,
        hidden: single.hidden,
        choices: choices ?? [],
        optional: param._tag === "Optional",
      },
    ];
  });
}

const globalFlags = permissionFlagsOf(ROOT_GLOBAL_FLAGS.map((entry) => entry.flag));

/**
 * Every flag a help document's command accepts: the root's globals, the flags captured by
 * `withPermissions` (which override a global of the same name), and any other visible flag the help
 * document lists, such as one a parent group shares.
 */
export function flagCatalogFor(doc: HelpDoc.HelpDoc): FlagCatalog {
  const catalog = new Map<string, PermissionFlag>(globalFlags.map((flag) => [flag.name, flag]));
  const own = Option.match(Context.getOption(doc.annotations, CommandFlagsAnnotation), {
    onNone: () => [],
    onSome: (readFlags) => readFlags(),
  });
  for (const flag of own) catalog.set(flag.name, flag);
  for (const flag of [...doc.flags, ...(doc.globalFlags ?? [])]) {
    if (catalog.has(flag.name)) continue;
    catalog.set(flag.name, {
      name: flag.name,
      kind: flag.type === "boolean" ? "boolean" : "text",
      hidden: false,
      choices: [],
      optional: !flag.required,
    });
  }
  return catalog;
}
