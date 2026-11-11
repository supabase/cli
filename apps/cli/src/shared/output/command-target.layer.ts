import { Effect, Layer, Option, Ref, Schema } from "effect";

import {
  CommandTarget,
  CommandTargetJson,
  type RenderedTarget,
  type TargetView,
} from "./command-target.service.ts";
import { MachineErrorContext } from "./machine-error-context.service.ts";
import { Output } from "./output.service.ts";
import { detailRows } from "./gutter.ts";
import { muted, warning } from "../../command-internal/colors.ts";

interface AnnouncedTargets {
  readonly texts: ReadonlyArray<string>;
  readonly first: Option.Option<CommandTargetJson>;
}

const encodeTargetJson = Schema.encodeEffect(CommandTargetJson);

/**
 * A target for people: the name, then the ID dim, then the branch, with production marked in
 * amber. Falls back to the announced text for targets without a view.
 */
const targetRow = (rendered: RenderedTarget, localHint: string | undefined): string => {
  const view = rendered.view;
  if (view === undefined) return rendered.text;
  const hint = rendered.json.kind === "local" ? localHint : undefined;
  return viewRow(view, hint);
};

const viewRow = (view: TargetView, hint?: string): string => {
  return [
    view.name ?? view.id,
    view.name === undefined || view.id === undefined ? undefined : muted(view.id, process.stderr),
    view.branch === undefined ? undefined : `branch ${view.branch}`,
    view.production === true ? warning("▲ Production", process.stderr) : undefined,
    view.preview === true ? warning("▲ Preview", process.stderr) : undefined,
    view.note === undefined ? undefined : muted(view.note, process.stderr),
    hint === undefined ? undefined : muted(hint, process.stderr),
  ]
    .filter((part) => part !== undefined)
    .join("  ");
};

export const commandTargetLayer = Layer.effect(
  CommandTarget,
  Effect.gen(function* () {
    const output = yield* Output;
    const state = yield* Ref.make<AnnouncedTargets>({ texts: [], first: Option.none() });
    const localHint = yield* Ref.make(Option.none<string>());
    // A parent held back for a terminal, printed under the subject or, failing that, at the end.
    const holding = yield* Ref.make(false);
    const heldParent = yield* Ref.make(Option.none<RenderedTarget>());
    const terminal = () => output.format === "text" && process.stderr.isTTY === true;
    const printHeld = (label: string) =>
      Ref.getAndSet(heldParent, Option.none()).pipe(
        Effect.flatMap((held) =>
          Option.isNone(held)
            ? Effect.void
            : output.raw(
                detailRows(
                  [
                    [
                      label,
                      viewRow({
                        ...(held.value.view ?? { id: held.value.text }),
                        production: false,
                      }),
                    ],
                  ],
                  process.stderr,
                ),
                "stderr",
              ),
        ),
      );
    yield* Effect.addFinalizer(() => printHeld("Target"));

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
          if (
            terminal() &&
            (yield* Ref.get(holding)) &&
            Option.isNone(yield* Ref.get(heldParent))
          ) {
            yield* Ref.set(heldParent, Option.some(rendered));
            return;
          }
          // A person at a terminal reads it as a context row; everyone else gets the established line.
          yield* output.raw(
            output.format === "text" && process.stderr.isTTY
              ? detailRows(
                  [["Target", targetRow(rendered, Option.getOrUndefined(hint))]],
                  process.stderr,
                )
              : `Target: ${text}\n`,
            "stderr",
          );
        }),
      holdAsParent: Ref.set(holding, true),
      announceSubject: (view: TargetView) =>
        terminal()
          ? output
              .raw(detailRows([["Target", viewRow(view)]], process.stderr), "stderr")
              .pipe(Effect.andThen(printHeld("Project")))
          : Effect.void,
      hintLocal: (hint: string) => Ref.set(localHint, Option.some(hint)),
      json: Ref.get(state).pipe(Effect.map((current) => current.first)),
      text: Ref.get(state).pipe(Effect.map((current) => Option.fromNullishOr(current.texts[0]))),
    });
  }),
);
