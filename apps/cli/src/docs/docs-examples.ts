import { Data, Effect } from "effect";
import type { Command } from "effect/cli";

import { exampleArgv, parseExample } from "../command-internal/command-facts/parse-example.ts";
import type { DocsSpec } from "./docs-spec.ts";

/** One or more published examples don't parse against the command tree. */
class DocsExamplesInvalidError extends Data.TaggedError("DocsExamplesInvalidError")<{
  readonly message: string;
}> {}

/**
 * Parses every example in the spec against the command tree without running a handler, failing
 * with each example that names an unknown command or flag or passes an invalid value. Examples
 * that don't start with `supabase` are skipped.
 */
export const checkDocsExamples = Effect.fn("DocsSpec.checkExamples")(function* (
  root: Command.Command.Any,
  spec: DocsSpec,
) {
  const failures: Array<string> = [];
  let checked = 0;
  for (const command of spec.commands) {
    for (const example of command.examples ?? []) {
      const argv = example.code === undefined ? undefined : exampleArgv(example.code);
      if (argv === undefined) continue;
      checked++;
      const result = yield* parseExample(root, argv);
      if (result._tag === "Invalid") {
        failures.push(`${command.id} "${example.code}": ${result.messages.join("; ")}`);
      }
    }
  }
  yield* Effect.annotateCurrentSpan({
    "examples.checked": checked,
    "examples.invalid": failures.length,
  });
  if (failures.length > 0) {
    return yield* new DocsExamplesInvalidError({
      message: `docs-examples.ts: ${failures.length} example(s) don't parse against the command tree:\n${failures.join("\n")}`,
    });
  }
});
