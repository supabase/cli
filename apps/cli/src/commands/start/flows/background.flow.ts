import { Effect } from "effect";
import { printStackConnectionInfo, startStackWithProgress } from "../start.shared.ts";

export const startBackground = Effect.fnUntraced(function* () {
  yield* startStackWithProgress();
  yield* printStackConnectionInfo();
});
