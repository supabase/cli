import { Effect, Schema } from "effect";
import { parse } from "yaml";
import type { Command } from "effect/cli";
import { docsCommandTree } from "../src/docs/docs-spec.ts";

const Flag = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  description: Schema.String,
  required: Schema.optionalKey(Schema.Boolean),
  default_value: Schema.String,
  accepted_values: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        type: Schema.String,
      }),
    ),
  ),
});

// The emitted clispec 001 subset consumed by supabase/supabase's Reference.sections.tsx.
const Spec = Schema.Struct({
  clispec: Schema.Literal("001"),
  info: Schema.Struct({
    id: Schema.NonEmptyString,
    version: Schema.NonEmptyString,
    title: Schema.String,
    language: Schema.String,
    source: Schema.String,
    bugs: Schema.String,
    spec: Schema.String,
    description: Schema.String,
    tags: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString, title: Schema.String })),
  }),
  flags: Schema.Array(Flag),
  commands: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      title: Schema.String,
      summary: Schema.String,
      description: Schema.String,
      examples: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            id: Schema.NonEmptyString,
            name: Schema.String,
            code: Schema.String,
            response: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
      tags: Schema.Array(Schema.String),
      links: Schema.Array(Schema.Never),
      usage: Schema.optionalKey(Schema.String),
      subcommands: Schema.Array(Schema.String),
      flags: Schema.Array(Flag),
    }),
  ),
});

class InvalidDocsSpec extends Schema.TaggedError<InvalidDocsSpec>()("InvalidDocsSpec", {
  message: Schema.String,
}) {}

export const validateDocsSpec = Effect.fn("Docs.validateSpec")(function* (
  yaml: string,
  version: string,
  root: Command.Command.Any,
) {
  const parsed: unknown = yield* Effect.try({
    try: () => parse(yaml),
    catch: (cause) => new InvalidDocsSpec({ message: `stdin is not valid YAML (${cause}).` }),
  });
  const spec = yield* Schema.decodeUnknownEffect(Spec)(parsed).pipe(
    Effect.mapError(
      (cause) => new InvalidDocsSpec({ message: `invalid clispec 001 document: ${cause.message}` }),
    ),
  );
  if (spec.info.version !== version) {
    return yield* new InvalidDocsSpec({
      message: `the spec's version "${spec.info.version}" does not match --version ${version}.`,
    });
  }
  const tree = docsCommandTree(root);
  const expected = new Set(tree.keys());
  const actual = new Set<string>();
  for (const command of spec.commands) {
    if (actual.has(command.id)) {
      return yield* new InvalidDocsSpec({ message: `duplicate command ${command.id}.` });
    }
    actual.add(command.id);
    const exampleIds = new Set<string>();
    for (const example of command.examples ?? []) {
      if (exampleIds.has(example.id)) {
        return yield* new InvalidDocsSpec({
          message: `duplicate example ${example.id} in ${command.id}.`,
        });
      }
      exampleIds.add(example.id);
    }
  }
  const missing = [...expected].filter((id) => !actual.has(id));
  const unexpected = [...actual].filter((id) => !expected.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    return yield* new InvalidDocsSpec({
      message: `command coverage mismatch; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}.`,
    });
  }
  for (const command of spec.commands) {
    const children = tree.get(command.id) ?? [];
    const supplied = new Set(command.subcommands);
    if (
      supplied.size !== command.subcommands.length ||
      children.length !== supplied.size ||
      children.some((id) => !supplied.has(id))
    ) {
      return yield* new InvalidDocsSpec({
        message: `subcommand coverage mismatch for ${command.id}. Expected: [${children.join(", ")}]; supplied: [${command.subcommands.join(", ")}].`,
      });
    }
  }
  yield* Effect.annotateCurrentSpan("docs.commands.count", actual.size);
  return spec;
});
