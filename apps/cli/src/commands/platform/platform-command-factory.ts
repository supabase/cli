import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { credentialsLayer } from "../../auth/credentials.layer.ts";
import { platformApiClientLayer } from "../../auth/platform-api-client.layer.ts";
import { withJsonErrorHandling } from "../../output/json-error-handling.ts";
import { stdinLayer } from "../../runtime/stdin.layer.ts";
import { buildPlatformGeneratedExamples } from "./platform-examples.ts";
import { runPlatformOperation } from "./platform-handler.ts";
import type { PlatformOperationDescriptor } from "./platform-types.ts";

const flags = {
  params: Flag.string("params").pipe(
    Flag.withDescription("Non-body request input as inline JSON, or - for stdin"),
    Flag.optional,
  ),
  json: Flag.string("json").pipe(
    Flag.withDescription("Object-shaped request body as inline JSON, or - for stdin"),
    Flag.optional,
  ),
  body: Flag.string("body").pipe(
    Flag.withDescription("Request body as inline non-object content, or - for stdin"),
    Flag.optional,
  ),
  bodyFile: Flag.string("body-file").pipe(
    Flag.withDescription("Read the raw request body from a file"),
    Flag.optional,
  ),
  upload: Flag.string("upload").pipe(
    Flag.atLeast(0),
    Flag.withDescription(
      "Multipart binary field input as field=path or field=-. Repeat for array-valued fields.",
    ),
    Flag.withDefault([] as ReadonlyArray<string>),
  ),
  fields: Flag.string("fields").pipe(
    Flag.withDescription("Comma-separated response field paths to keep in the output"),
    Flag.optional,
  ),
  schema: Flag.boolean("schema").pipe(
    Flag.withDescription(
      "Show the request and response schema for this command instead of executing it",
    ),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Validate and preview the outgoing request without executing it"),
  ),
  yes: Flag.boolean("yes").pipe(
    Flag.withDescription("Skip the confirmation prompt for this mutating request"),
  ),
} as const;

type PlatformCommandFlags = CliCommand.Command.Config.Infer<typeof flags>;
type PlatformCliCommand = CliCommand.Command<
  string,
  PlatformCommandFlags | never,
  {},
  never,
  never
>;

const platformApiLayer = platformApiClientLayer.pipe(Layer.provide(credentialsLayer));

function bodyFlagHints(descriptor: PlatformOperationDescriptor): ReadonlyArray<string> {
  if (descriptor.request.body.kind === "none") {
    return [];
  }
  if (
    descriptor.request.body.kind === "json" &&
    descriptor.request.body.schema?.kind === "object"
  ) {
    return ["Provide request body fields with `--json`."];
  }
  if (descriptor.request.body.kind === "binary") {
    return ["Provide request body bytes with `--body-file <path>` or `--body -` for stdin."];
  }
  if (descriptor.request.body.kind === "multipart") {
    return [
      "Provide structured multipart fields with `--json`.",
      "Provide binary multipart fields with `--upload field=path` or `--upload field=-`.",
    ];
  }
  if (descriptor.request.body.kind === "urlencoded") {
    return [
      "Provide request body fields with `--json`. The CLI serializes them as urlencoded form data.",
    ];
  }
  return ["Provide the request body with `--body`."];
}

export function makePlatformLeafCommand(
  descriptor: PlatformOperationDescriptor,
): PlatformCliCommand {
  const handler = runPlatformOperation({
    descriptor,
    execute: (input) =>
      Effect.suspend(() => descriptor.execute(input).pipe(Effect.provide(platformApiLayer))),
  });
  const method = descriptor.commandPath.slice(1).join(".");
  const bodyHints = bodyFlagHints(descriptor);
  const generatedExamples = buildPlatformGeneratedExamples(descriptor);
  const command = Command.make(
    descriptor.commandPath[descriptor.commandPath.length - 1]!,
    flags,
  ).pipe(
    Command.withDescription(
      [
        descriptor.description,
        "",
        `Inspect the request and response schema with \`supabase platform schema ${method}\`.`,
        ...bodyHints,
      ].join("\n"),
    ),
    Command.withShortDescription(descriptor.shortDescription),
  );
  const withExamples =
    generatedExamples.commandExamples.length > 0
      ? command.pipe(Command.withExamples(generatedExamples.commandExamples))
      : command;

  return withExamples.pipe(
    Command.withHandler((commandFlags) =>
      handler(commandFlags).pipe(
        Effect.withSpan(`command.${descriptor.commandPath.join(".")}`),
        withJsonErrorHandling,
      ),
    ),
    Command.provide(stdinLayer),
  );
}
