import type { Effect, Option } from "effect";
import { ServiceMap } from "effect";

interface StdinShape {
  readonly isTTY: boolean;
  readonly readPipedToken: Effect.Effect<Option.Option<string>>;
}

export class Stdin extends ServiceMap.Service<Stdin, StdinShape>()("@supabase/cli/runtime/Stdin") {}
