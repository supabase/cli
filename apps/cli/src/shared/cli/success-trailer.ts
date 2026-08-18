import { Context, Effect, Layer, Option, Ref } from "effect";

import { Output } from "../output/output.service.ts";

interface SuccessTrailerShape {
  readonly append: (text: string) => Effect.Effect<void>;
  readonly takeAll: Effect.Effect<ReadonlyArray<string>>;
  readonly setWorkingDirectory: (cwd: string) => Effect.Effect<void>;
  readonly workingDirectory: Effect.Effect<string | undefined>;
}

export class SuccessTrailer extends Context.Service<SuccessTrailer, SuccessTrailerShape>()(
  "supabase/cli/SuccessTrailer",
) {}

export const successTrailerLayer = Layer.effect(
  SuccessTrailer,
  Effect.gen(function* () {
    const empty: ReadonlyArray<string> = [];
    const pending = yield* Ref.make(empty);
    const workingDirectory = yield* Ref.make<string | undefined>(undefined);

    return SuccessTrailer.of({
      append: (text) => Ref.update(pending, (trailers) => [...trailers, text]),
      takeAll: Effect.gen(function* () {
        const trailers = yield* Ref.get(pending);
        yield* Ref.set(pending, empty);
        return trailers;
      }),
      setWorkingDirectory: (cwd) => Ref.set(workingDirectory, cwd),
      workingDirectory: Ref.get(workingDirectory),
    });
  }),
);

export const setSuccessWorkingDirectory = Effect.fnUntraced(function* (cwd: string) {
  const trailers = yield* Effect.serviceOption(SuccessTrailer);
  if (Option.isSome(trailers)) {
    yield* trailers.value.setWorkingDirectory(cwd);
  }
});

export const emitSuccessTrailer = Effect.fnUntraced(function* (text: string) {
  const trailers = yield* Effect.serviceOption(SuccessTrailer);
  if (Option.isSome(trailers)) {
    return yield* trailers.value.append(text);
  }

  const output = yield* Output;
  yield* output.raw(text, "stderr");
});
