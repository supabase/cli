import { Effect, Stream } from "effect";
import { Stack } from "@supabase/stack/internals";
import { Output } from "../../../output/output.service.ts";
import { interruptOnSignal } from "../signal.ts";
import { printStackConnectionInfo, startStackWithProgress } from "../start.shared.ts";

export const startNonInteractive = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const stack = yield* Stack;

  return yield* Effect.gen(function* () {
    yield* startStackWithProgress();
    yield* printStackConnectionInfo();
    yield* stack
      .allStateChanges()
      .pipe(Stream.runForEach((state) => output.info(`${state.name}: ${state.status}`)));
  })
    .pipe(Effect.raceFirst(interruptOnSignal))
    .pipe(
      Effect.ensuring(
        Effect.uninterruptible(stack.dispose().pipe(Effect.catch(() => Effect.void))),
      ),
    );
});
