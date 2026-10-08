import { Context, Option } from "effect";
import { Command, Flag, type Param } from "effect/unstable/cli";

import type { CliConfigCodec, CliConfigKey } from "./cli-config-key.ts";

/** Another key a flag assigns when it is passed, e.g. `--sql-paths` forcing seeding on. */
type CliConfigFlagAlso = readonly [key: { readonly path: string }, value: unknown];

export interface CliConfigFlagOptions<X> {
  readonly name: string;
  readonly alias?: string;
  readonly description: string;
  /** Converts the parsed flag value to the key's value, e.g. `--no-seed` to `enabled = false`. */
  readonly map?: (value: X) => X;
  readonly also?: ReadonlyArray<CliConfigFlagAlso>;
}

export interface CliConfigFlagAssignment {
  readonly path: string;
  readonly flag: string;
  readonly value: unknown;
}

export interface CliConfigFlagBinding {
  readonly flag: string;
  readonly path: string;
  /** Reads the parsed `Option` for this flag; `undefined` when the flag was not passed. */
  readonly assignments: (parsed: unknown) => ReadonlyArray<CliConfigFlagAssignment> | undefined;
}

const bindings = new WeakMap<object, CliConfigFlagBinding>();

/** The binding a `key.flag(...)` constructor attached to a flag, if it built this one. */
export const cliConfigFlagBinding = (param: Param.Any): CliConfigFlagBinding | undefined =>
  bindings.get(param);

const optionOf = <X>(value: X | undefined): Option.Option<X> =>
  value === undefined ? Option.none() : Option.some(value);

const viaCodec = <X>(
  flag: Flag.Flag<Option.Option<unknown>>,
  codec: CliConfigCodec<X>,
): Flag.Flag<Option.Option<X>> =>
  Flag.map(
    flag,
    Option.flatMap((value) => optionOf(codec.fromConfig(value))),
  );

const baseFlag = <X>(codec: CliConfigCodec<X>, name: string): Flag.Flag<Option.Option<X>> => {
  switch (codec.kind) {
    case "bool":
    case "binary":
      return viaCodec(Flag.optional(Flag.boolean(name)), codec);
    case "uint":
    case "port":
      return viaCodec(Flag.optional(Flag.integer(name)), codec);
    case "literal":
      return viaCodec(Flag.optional(Flag.choice(name, codec.literals ?? [])), codec);
    case "string":
      return viaCodec(Flag.optional(Flag.string(name)), codec);
    case "commaList":
      return Flag.string(name).pipe(
        Flag.atLeast(0),
        Flag.map((values) =>
          values.length === 0 ? Option.none() : optionOf(codec.fromConfig(values)),
        ),
      );
  }
};

/** Builds the `Flag.optional` flag for `key` and records its binding. Used by `key.flag(...)`. */
export const makeCliConfigKeyFlag = <A, X>(
  key: CliConfigKey<A, X>,
  options: CliConfigFlagOptions<X>,
): Flag.Flag<Option.Option<X>> => {
  const described = baseFlag(key.codec, options.name).pipe(
    Flag.withDescription(options.description),
  );
  const flag =
    options.alias === undefined ? described : described.pipe(Flag.withAlias(options.alias));
  bindings.set(flag, {
    flag: options.name,
    path: key.path,
    assignments: (parsed) => {
      if (!Option.isOption(parsed) || Option.isNone(parsed)) return undefined;
      const decoded = key.codec.fromConfig(parsed.value);
      if (decoded === undefined) return undefined;
      return [
        { path: key.path, flag: options.name, value: options.map?.(decoded) ?? decoded },
        ...(options.also ?? []).map(([other, value]) => ({
          path: other.path,
          flag: options.name,
          value,
        })),
      ];
    },
  });
  return flag;
};

/** The explicitly passed flags that bind to config keys, keyed by key path. */
export class CliConfigFlagInputs extends Context.Service<
  CliConfigFlagInputs,
  ReadonlyMap<string, CliConfigFlagAssignment>
>()("supabase/cli/CliConfigFlagInputs") {}

/** Command annotation listing the bound flags, so a tree walk can find them. */
export class CliConfigFlagBindings extends Context.Service<
  CliConfigFlagBindings,
  ReadonlyArray<CliConfigFlagBinding>
>()("supabase/cli/CliConfigFlagBindings") {}

interface BoundParam {
  readonly accessor: ReadonlyArray<string | number>;
  readonly binding: CliConfigFlagBinding;
}

const collectBound = (
  node: unknown,
  accessor: ReadonlyArray<string | number>,
  found: Array<BoundParam>,
): void => {
  if (typeof node !== "object" || node === null) return;
  const binding = bindings.get(node);
  if (binding !== undefined) {
    found.push({ accessor, binding });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child, index) => collectBound(child, [...accessor, index], found));
    return;
  }
  for (const [name, child] of Object.entries(node)) {
    collectBound(child, [...accessor, name], found);
  }
};

const readAt = (input: unknown, accessor: ReadonlyArray<string | number>): unknown =>
  accessor.reduce<unknown>(
    (node, segment) =>
      typeof node === "object" && node !== null ? Reflect.get(node, segment) : undefined,
    input,
  );

/**
 * Provides {@link CliConfigFlagInputs} from the parsed command input and annotates the command with
 * its bound flags. `config` is the same record passed to `Command.make`.
 */
export const withCliConfigFlags = <const C extends Command.Command.Config>(config: C) => {
  const bound: Array<BoundParam> = [];
  collectBound(config, [], bound);
  const annotated = bound.map((entry) => entry.binding);

  return <const Name extends string, E, R, ContextInput>(
    self: Command.Command<Name, Command.Command.Config.Infer<C>, ContextInput, E, R>,
  ) =>
    self.pipe(
      Command.provideSync(CliConfigFlagInputs, (input: Command.Command.Config.Infer<C>) => {
        const inputs = new Map<string, CliConfigFlagAssignment>();
        for (const entry of bound) {
          for (const assignment of entry.binding.assignments(readAt(input, entry.accessor)) ?? []) {
            inputs.set(assignment.path, assignment);
          }
        }
        return inputs;
      }),
      Command.annotate(CliConfigFlagBindings, annotated),
    );
};
