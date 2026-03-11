import { Effect } from "effect";
import { Output } from "../../../output/output.service.ts";
import { printStackConnectionInfo, startStackWithProgress } from "../start.shared.ts";

export const startBackground = Effect.fnUntraced(function* () {
  const output = yield* Output;
  yield* startStackWithProgress();
  yield* printStackConnectionInfo();
  yield* output.outro("Local Supabase stack is ready.");
});
