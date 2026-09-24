import type { Stack } from "../src/effect.ts";
import { Effect } from "effect";

export const destroyTestStack = (stack: Stack): Effect.Effect<void, never> =>
  stack.destroy.pipe(Effect.orDie);
