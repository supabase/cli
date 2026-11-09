import { Context, Effect, Schema } from "effect";
import { Command } from "effect/cli";

import { Output } from "../../shared/output/output.service.ts";

/** A command's declared result: the schema machine formats encode with, and the text renderer. */
export interface CommandOutputSpec<A, I> {
  readonly schema: Schema.Codec<A, I>;
  readonly text: (value: A) => Effect.Effect<void, never, Output>;
}

/** Context key under which a command's output schema is stored in `Command.annotations`. */
export class OutputSchemaAnnotation extends Context.Service<OutputSchemaAnnotation, Schema.Top>()(
  "supabase/OutputSchema",
) {}

/** Builds an output spec. */
export const make = <A, I>(spec: CommandOutputSpec<A, I>): CommandOutputSpec<A, I> => spec;

const legacyResult = (method: string) =>
  Effect.die(
    new Error(`Output.${method} is unavailable in a command that declares an output schema`),
  );

/**
 * Runs `effect` and writes its result: encoded with the spec's schema for json and stream-json,
 * through the spec's renderer for text. Inside `effect`, `Output.success` and `Output.result` die.
 */
export const emit =
  <A, I>(spec: CommandOutputSpec<A, I>) =>
  <E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, E, R | Output> =>
    Effect.gen(function* () {
      const output = yield* Output;
      const value = yield* effect.pipe(
        Effect.updateService(Output, (current) =>
          Output.of({
            ...current,
            success: () => legacyResult("success"),
            result: () => legacyResult("result"),
          }),
        ),
      );
      if (output.format === "text") return yield* spec.text(value);
      const encoded = yield* Schema.encodeEffect(spec.schema)(value).pipe(Effect.orDie);
      yield* output.result(encoded);
    }).pipe(Effect.withSpan("CommandOutput.emit"));

/**
 * Sets a handler that returns the command's result and declares its output schema. `around` wraps
 * the emitting effect, for telemetry and machine-format error handling.
 */
export const withHandler =
  <Input, A, I, E, R, E2, R2>(
    spec: CommandOutputSpec<A, I>,
    handler: (input: Input) => Effect.Effect<A, E, R>,
    around: (
      effect: Effect.Effect<void, E, R | Output>,
      input: Input,
    ) => Effect.Effect<unknown, E2, R2>,
  ) =>
  <Name extends string, ContextInput, XE, XR>(
    self: Command.Command<Name, Input, ContextInput, XE, XR>,
  ) =>
    self.pipe(
      Command.annotate(OutputSchemaAnnotation, spec.schema),
      Command.withHandler((input: Input) =>
        Effect.asVoid(around(emit(spec)(handler(input)), input)),
      ),
    );
