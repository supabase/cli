import { Effect } from "effect";
import { setExperiments } from "../experiments.shared.ts";
import type { ExperimentsDisableFlags } from "./disable.command.ts";

export const experimentsDisable = Effect.fn("experiments.disable")(function* (
  flags: ExperimentsDisableFlags,
) {
  yield* setExperiments({
    features: flags.features,
    enabled: false,
    command: "experiments disable",
  });
});
