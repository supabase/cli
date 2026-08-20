import { Effect } from "effect";
import { Output } from "../output/output.service.ts";
import type { SchemaCommandResult } from "./schema-types.ts";

export const renderSchemaResult = Effect.fnUntraced(function* (
  title: string,
  result: SchemaCommandResult,
) {
  const output = yield* Output;
  yield* output.intro(title);
  if (output.format !== "text") {
    yield* output.success(result.message, result.data);
    return;
  }
  const lines = result.message.split("\n").filter((line) => line.length > 0);
  if (result.status === "failed") {
    for (const line of lines) yield* output.info(line);
    yield* writeNextActions(output, result.nextActions);
    yield* output.outro("Failed.");
    return;
  }
  for (const line of lines.slice(1)) yield* output.info(line);
  yield* writeNextActions(output, result.nextActions);
  yield* output.outro(lines[0] ?? "Done.");
});

const writeNextActions = Effect.fnUntraced(function* (
  output: {
    readonly info: (message: string) => Effect.Effect<void>;
  },
  actions: ReadonlyArray<string>,
) {
  if (actions.length === 0) return;
  if (actions.length === 1) {
    yield* output.info(`Next: ${actions[0]}`);
    return;
  }
  yield* output.info("Next:");
  for (const [index, action] of actions.entries()) {
    yield* output.info(`  ${index + 1}. ${action}`);
  }
});
