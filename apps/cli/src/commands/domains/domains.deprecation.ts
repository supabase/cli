import { Effect, Option } from "effect";

import { Output } from "../../shared/output/output.service.ts";

const INCLUDE_RAW_OUTPUT_DEPRECATION =
  "Flag --include-raw-output is deprecated and will be removed in v3, use -o json instead.\n";

export const warnIncludeRawOutputDeprecated = Effect.fnUntraced(function* (
  includeRawOutput: Option.Option<boolean>,
) {
  if (Option.isNone(includeRawOutput)) {
    return;
  }
  const output = yield* Output;
  yield* output.raw(INCLUDE_RAW_OUTPUT_DEPRECATION, "stderr");
});
