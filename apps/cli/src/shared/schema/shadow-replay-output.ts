import { Effect } from "effect";
import { Output } from "../output/output.service.ts";

const APPLYING_MIGRATION_PREFIX = "Applying migration ";
const REPLAY_BANNER =
  "Replaying migrations on a shadow to compare catalogs (not a live apply)...\n";

export function wrapShadowReplayOutput(
  real: typeof Output.Service,
  opts: { readonly debug: boolean },
): typeof Output.Service {
  let announced = false;
  return Output.of({
    ...real,
    raw: (text, stream = "stdout") =>
      Effect.suspend(() => {
        if (!text.startsWith(APPLYING_MIGRATION_PREFIX)) {
          return real.raw(text, stream);
        }
        if (opts.debug) {
          return real.raw(`Shadow: ${text}`, stream);
        }
        if (real.format !== "text" || announced) {
          return Effect.void;
        }
        announced = true;
        return real.raw(REPLAY_BANNER, stream);
      }),
  });
}
