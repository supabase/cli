import { Effect } from "effect";
import { setExperiments } from "../experiments.shared.ts";
import type { ExperimentsEnableFlags } from "./enable.command.ts";

export const experimentsEnable = Effect.fn("experiments.enable")(function* (
  flags: ExperimentsEnableFlags,
) {
  yield* setExperiments({
    features: flags.features,
    enabled: true,
    command: "experiments enable",
  });
});
