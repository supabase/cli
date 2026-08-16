import { Effect } from "effect";
import { Output } from "../output/output.service.ts";

/**
 * `Target: remote "<name>" (<ref>)` — via `Output.raw(..., "stderr")` so it
 * survives text, json, AND stream-json. Called at both ref seams right
 * before the resolved ref is handed back, so it always prints before the
 * first mutation/network write a caller makes with it.
 */
export const emitRemoteTarget = Effect.fnUntraced(function* (name: string, ref: string) {
  const output = yield* Output;
  yield* output.raw(`Target: remote "${name}" (${ref})\n`, "stderr");
});
