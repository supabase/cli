import { Effect, Layer, Option, Ref } from "effect";

import { CommandTarget, type RenderedTarget, type TargetJson } from "./command-target.service.ts";
import { MachineErrorContext } from "./machine-error-context.service.ts";
import { Output } from "./output.service.ts";

interface AnnouncedTargets {
  readonly texts: ReadonlyArray<string>;
  readonly first: Option.Option<TargetJson>;
}

export const commandTargetLayer = Layer.effect(
  CommandTarget,
  Effect.gen(function* () {
    const output = yield* Output;
    const state = yield* Ref.make<AnnouncedTargets>({ texts: [], first: Option.none() });

    return CommandTarget.of({
      announce: (rendered: RenderedTarget) =>
        Effect.gen(function* () {
          const outcome = yield* Ref.modify(
            state,
            (current): readonly ["repeat" | "first" | "additional", AnnouncedTargets] =>
              current.texts.includes(rendered.text)
                ? ["repeat", current]
                : [
                    Option.isNone(current.first) ? "first" : "additional",
                    {
                      texts: [...current.texts, rendered.text],
                      first: Option.isNone(current.first)
                        ? Option.some(rendered.json)
                        : current.first,
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
                yield* context.value.set({ target: rendered.json });
              }
            }
          }
          yield* output.raw(`Target: ${rendered.text}\n`, "stderr");
        }),
      json: Ref.get(state).pipe(Effect.map((current) => current.first)),
      text: Ref.get(state).pipe(Effect.map((current) => Option.fromNullishOr(current.texts[0]))),
    });
  }),
);
