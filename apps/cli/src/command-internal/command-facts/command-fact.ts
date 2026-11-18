import { Context, Effect, Option, Schema } from "effect";
import type { Command } from "effect/cli";

/** How a fact is enforced: by the compiler, by a render-time check, by a runtime gate, or not at all. */
export type FactCheck = "compiler" | "render" | "runtime" | "none";

/** A command fact stored under one `Context` key on `Command.annotations`, serialized for the catalog. */
export interface CommandFact {
  readonly id: string;
  readonly checked: ReadonlyArray<FactCheck>;
  readonly read: (command: Command.Command.Any) => Option.Option<Effect.Effect<unknown>>;
}

/**
 * Registers an annotation key as a fact whose value is encoded with `schema`. The schema may
 * describe a subset of the stored value; encoding drops fields it doesn't declare.
 */
export const registerFact = <I, A extends T, T, E>(
  key: Context.Key<I, A>,
  options: { readonly schema: Schema.Codec<T, E>; readonly checked: ReadonlyArray<FactCheck> },
): CommandFact => {
  const encode = Schema.encodeEffect(options.schema);
  return {
    id: key.key,
    checked: options.checked,
    read: (command) =>
      Option.map(Context.getOption(command.annotations, key), (value) =>
        encode(value).pipe(Effect.orDie),
      ),
  };
};

/** Registers an annotation key whose value the catalog derives with `serialize`, such as a schema's JSON Schema. */
export const registerDerivedFact = <I, A>(
  key: Context.Key<I, A>,
  options: {
    readonly serialize: (value: A) => unknown;
    readonly checked: ReadonlyArray<FactCheck>;
  },
): CommandFact => ({
  id: key.key,
  checked: options.checked,
  read: (command) =>
    Option.map(Context.getOption(command.annotations, key), (value) =>
      Effect.sync(() => options.serialize(value)),
    ),
});
