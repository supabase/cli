import { Effect } from "effect";
import { Output } from "../output/output.service.ts";
import type { SchemaCommandResult } from "./schema-types.ts";

export const renderSchemaResult = Effect.fnUntraced(function* (
  title: string,
  result: SchemaCommandResult,
) {
  const output = yield* Output;
  yield* output.intro(title);
  if (output.format === "text") {
    for (const line of result.message.split("\n")) {
      yield* output.info(line);
    }
    if (result.nextActions.length > 0) {
      yield* output.info(`Next: ${result.nextActions.join(" | ")}`);
    }
    yield* output.outro(result.status === "failed" ? "Failed." : result.message.split("\n")[0]!);
    return;
  }
  yield* output.success(result.message, result.data);
});
