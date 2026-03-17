import type { Effect, Option } from "effect";
import { ServiceMap } from "effect";

interface StdinShape {
  readonly isTTY: boolean;
  readonly readPipedBytes: Effect.Effect<Option.Option<Uint8Array>>;
  readonly readPipedText: Effect.Effect<Option.Option<string>>;
}

export class Stdin extends ServiceMap.Service<Stdin, StdinShape>()("@supabase/cli/runtime/Stdin") {}
