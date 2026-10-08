import { Context, Effect, Option } from "effect";
import { Command, Flag, type Param } from "effect/unstable/cli";

import type { CliConfigCodec, CliConfigKey } from "./cli-config-key.ts";
import { CliConfigValueError } from "./cli-config.errors.ts";

/** The flag names (and short aliases) a key declares; `key.flag` accepts only these. */
export interface CliConfigFlagDeclaration {
  readonly names: ReadonlyArray<string>;
  readonly aliases?: ReadonlyArray<string>;
}

/** The declaration of a key that no flag overrides. */
export type CliConfigNoFlags = { readonly names: readonly [] };

type FlagAlias<F extends CliConfigFlagDeclaration> = F extends {
  readonly aliases: ReadonlyArray<infer Alias extends string>;
}
  ? Alias
  : never;

/** Another key a flag assigns when it is passed, e.g. `--sql-paths` forcing seeding on. */
type CliConfigFlagAlso = readonly [key: { readonly path: string }, value: unknown];

export interface CliConfigFlagOptions<
  X,
  F extends CliConfigFlagDeclaration = CliConfigFlagDeclaration,
> {
  readonly name: F["names"][number];
  readonly alias?: FlagAlias<F>;
  readonly description: string;
  /**
   * Converts the parsed flag value to the key's value, e.g. `--no-seed` to `enabled = false`.
   * Returning `undefined` means the flag assigns nothing, as for a negatable flag left at its
   * negative default.
   */
  readonly map?: (value: X) => X | undefined;
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

const parsedFlag = <X>(
  flag: Flag.Flag<unknown>,
  codec: CliConfigCodec<X>,
  path: string,
): Flag.Flag<Option.Option<X>> =>
  flag.pipe(
    Flag.filterMap(
      (value) => optionOf(codec.fromConfig(value)),
      (value) => codec.describe(path, String(value)),
    ),
    Flag.optional,
  );

const baseFlag = <X>(
  codec: CliConfigCodec<X>,
  name: string,
  path: string,
): Flag.Flag<Option.Option<X>> => {
  switch (codec.kind) {
    case "bool":
    case "binary":
      return parsedFlag(Flag.boolean(name), codec, path);
    case "uint":
    case "port":
      return parsedFlag(Flag.integer(name), codec, path);
    case "literal":
      return parsedFlag(Flag.choice(name, codec.literals ?? []), codec, path);
    case "string":
      return parsedFlag(Flag.string(name), codec, path);
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
export const makeCliConfigKeyFlag = <A, X, F extends CliConfigFlagDeclaration>(
  key: CliConfigKey<A, X, F>,
  options: CliConfigFlagOptions<X, F>,
): Flag.Flag<Option.Option<X>> => {
  const described = baseFlag(key.codec, options.name, key.path).pipe(
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
      const value = options.map === undefined ? decoded : options.map(decoded);
      if (value === undefined) return undefined;
      return [
        { path: key.path, flag: options.name, value },
        ...(options.also ?? []).map(([other, otherValue]) => ({
          path: other.path,
          flag: options.name,
          value: otherValue,
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
      Command.provideEffect(CliConfigFlagInputs, (input: Command.Command.Config.Infer<C>) =>
        Effect.gen(function* () {
          const inputs = new Map<string, CliConfigFlagAssignment>();
          for (const entry of bound) {
            for (const assignment of entry.binding.assignments(readAt(input, entry.accessor)) ??
              []) {
              const prior = inputs.get(assignment.path);
              if (prior !== undefined) {
                return yield* new CliConfigValueError({
                  path: assignment.path,
                  tier: "flag",
                  flag: assignment.flag,
                  message: `--${prior.flag} and --${assignment.flag} both set ${assignment.path}; pass only one`,
                });
              }
              inputs.set(assignment.path, assignment);
            }
          }
          return inputs;
        }),
      ),
      Command.annotate(CliConfigFlagBindings, annotated),
    );
};
