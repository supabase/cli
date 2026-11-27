import { UiSchema } from "@effect/ui";
import { Effect, Option, Schema } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";

import { Terminal, TerminalCommand, TerminalHost } from "@supabase/ui-terminal";

import { Select, SelectProps } from "./blocks.ts";

interface SelectConfig<A> {
  readonly message: string;
  readonly options: NonEmptyReadonlyArray<{
    readonly value: A;
    readonly label: string;
    readonly hint?: string;
  }>;
  readonly initial?: A;
}

const PromptModel = Schema.Struct({ index: Schema.NullOr(Schema.Finite) });
const PromptMessage = UiSchema.TaggedEnum({ SubmittedSelect: { index: Schema.Finite } });

const SelectPrompt = Terminal.component({
  name: "SelectPrompt",
  props: SelectProps,
  model: PromptModel,
  message: PromptMessage,
}).make({
  init: () => ({ index: null }),
  update: {
    SubmittedSelect: ($, { index }) => $.evolve({ index }).run(TerminalCommand.finish()),
  },
  view: (h) =>
    Select(h, {
      props: h.props,
      onEmit: { Submitted: ({ index }) => PromptMessage.SubmittedSelect({ index }) },
    }),
});

/**
 * Shows a list inline below the shell prompt and resolves with the chosen value. The submitted
 * state stays in the scrollback with the cursor below it. Fails with `NonInteractive` without a TTY.
 */
export const select = Effect.fn("Ui.select")(function* <A>(config: SelectConfig<A>) {
  const terminal = yield* TerminalHost.Transport;
  const initial =
    config.initial === undefined
      ? {}
      : {
          initial: Math.max(
            0,
            config.options.findIndex((option) => option.value === config.initial),
          ),
        };
  const final = yield* TerminalHost.run(SelectPrompt, {
    message: config.message,
    options: config.options.map(({ label, hint }) => ({
      label,
      ...(hint === undefined ? {} : { hint }),
    })),
    ...initial,
    unicode: terminal.capabilities.unicode,
  });
  const chosen = Option.fromNullishOr(final?.index).pipe(
    Option.flatMap((index) => Option.fromNullishOr(config.options[index])),
  );
  return yield* Option.match(chosen, {
    onNone: () => Effect.die("prompt finished without a selection"),
    onSome: (option) => Effect.succeed(option.value),
  });
});
