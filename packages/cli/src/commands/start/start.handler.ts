import { Effect } from "effect";
import { Output } from "../../output/output.service.ts";
import type { StartFlags } from "./start.command.ts";
import { startBackground } from "./flows/background.flow.ts";
import { startForeground } from "./flows/foreground.flow.ts";
import { startNonInteractive } from "./flows/non-interactive.flow.ts";

export const start = Effect.fnUntraced(function* (flags: StartFlags) {
  if (flags.detach) {
    return yield* startBackground();
  }

  const output = yield* Output;
  if (output.interactive) {
    return yield* startForeground();
  }
  return yield* startNonInteractive();
});
