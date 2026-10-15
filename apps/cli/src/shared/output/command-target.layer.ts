import { Effect, Layer, Option, Ref, Schema } from "effect";

import {
  CommandTarget,
  CommandTargetJson,
  type RenderedTarget,
} from "./command-target.service.ts";
import { MachineErrorContext } from "./machine-error-context.service.ts";
import { Output } from "./output.service.ts";

interface AnnouncedTargets {
  readonly texts: ReadonlyArray<string>;
  readonly first: Option.Option<CommandTargetJson>;
}

const encodeTargetJson = Schema.encodeEffect(CommandTargetJson);

export const commandTargetLayer = Layer.effect(
  CommandTarget,
  Effect.gen(function* () {
    const output = yield* Output;
    const state = yield* Ref.make<AnnouncedTargets>({ texts: [], first: Option.none() });
    const localHint = yield* Ref.make(Option.none<string>());

    return CommandTarget.of({
      announce: (rendered: RenderedTarget) =>
        Effect.gen(function* () {
          const hint = yield* Ref.get(localHint);
          const text =
            rendered.json.kind === "local" && Option.isSome(hint)
              ? `${rendered.text} · ${hint.value}`
              : rendered.text;
          const json = yield* encodeTargetJson(rendered.json).pipe(Effect.orDie);
          const outcome = yield* Ref.modify(
            state,
            (current): readonly ["repeat" | "first" | "additional", AnnouncedTargets] =>
              current.texts.includes(text)
                ? ["repeat", current]
                : [
                    Option.isNone(current.first) ? "first" : "additional",
                    {
                      texts: [...current.texts, text],
                      first: Option.isNone(current.first) ? Option.some(json) : current.first,
                    },
                  ],
          );
          if (outcome === "repeat") return;
          if (outcome === "first") {
            // Read at call time so a command that shadows the root cell receives the target.
            const context = yield* Effect.serviceOption(MachineErrorContext);
            if (Option.isSome(context)) {
              const recorded = yield* context.value.get;
              if (recorded.target === undefined) {
                yield* context.value.set({ target: json });
              }
            }
          }
          yield* output.raw(`Target: ${text}\n`, "stderr");
        }),
      hintLocal: (hint: string) => Ref.set(localHint, Option.some(hint)),
      json: Ref.get(state).pipe(Effect.map((current) => current.first)),
      text: Ref.get(state).pipe(Effect.map((current) => Option.fromNullishOr(current.texts[0]))),
    });
  }),
);
