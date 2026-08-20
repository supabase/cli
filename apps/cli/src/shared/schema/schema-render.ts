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
  const next =
    result.nextActions.length > 0 ? `Next: ${result.nextActions.join(" | ")}` : undefined;
  if (result.status === "failed") {
    for (const line of lines) yield* output.info(line);
    if (next !== undefined) yield* output.info(next);
    yield* output.outro("Failed.");
    return;
  }
  for (const line of lines.slice(1)) yield* output.info(line);
  if (next !== undefined) yield* output.info(next);
  yield* output.outro(lines[0] ?? "Done.");
});
