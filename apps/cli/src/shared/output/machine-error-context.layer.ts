import { Effect, Layer, Ref } from "effect";

import { MachineErrorContext } from "./machine-error-context.service.ts";

/**
 * One mutable cell per command invocation, starting empty. See
 * `MachineErrorContext`'s doc comment for the opt-in contract this backs.
 */
export const machineErrorContextLayer = Layer.effect(
  MachineErrorContext,
  Effect.gen(function* () {
    const ref = yield* Ref.make<Record<string, unknown>>({});
    return MachineErrorContext.of({
      set: (fields) => Ref.update(ref, (current) => ({ ...current, ...fields })),
      get: Ref.get(ref),
    });
  }),
);
