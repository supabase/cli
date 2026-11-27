import { expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Schema } from "effect";

import { unsupportedOutputFlagMessage } from "../../../command-internal/output-formats.ts";
import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

const JsonEnvelope = Schema.Struct({
  error: Schema.Struct({ message: Schema.String, suggestion: Schema.String }),
});

const MarkdownResult = Schema.Struct({ markdown: Schema.String });

const ResultEvent = Schema.Struct({
  type: Schema.Literal("result"),
  data: MarkdownResult,
});

const ErrorEnvelope = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });

it.live("prints raw markdown for text and carries it in a markdown field for json formats", () =>
  Effect.gen(function* () {
    const [text, json, streamJson] = yield* Effect.forEach(
      ["text", "json", "stream-json"],
      (format) => runSupabaseEffect(["skill", "display", "--output-format", format]),
    );

    expect(text?.exitCode, text?.stderr).toBe(0);
    expect(text?.stderr).toBe("");
    expect(text?.stdout).toMatch(/^# Supabase CLI: agent overview/);
    expect(text?.stdout).toContain("\n## Targeting\n");

    expect(json?.exitCode, json?.stderr).toBe(0);
    const jsonResult = yield* Schema.decodeEffect(Schema.fromJsonString(MarkdownResult))(
      json?.stdout ?? "",
    );
    expect(jsonResult.markdown).toBe(text?.stdout);

    expect(streamJson?.exitCode, streamJson?.stderr).toBe(0);
    const event = yield* Schema.decodeEffect(Schema.fromJsonString(ResultEvent))(
      streamJson?.stdout ?? "",
    );
    expect(event.data.markdown).toBe(text?.stdout);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live("reports an unknown topic as a JSON error envelope listing the topics", () =>
  Effect.gen(function* () {
    const result = yield* runSupabaseEffect([
      "skill",
      "display",
      "nope",
      "--output-format",
      "json",
    ]);

    expect(result.exitCode).not.toBe(0);
    const envelope = yield* Schema.decodeEffect(Schema.fromJsonString(JsonEnvelope))(result.stdout);
    expect(envelope.error.message).toContain("Unknown skill topic");
    expect(envelope.error.suggestion).toContain("overview");
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live("rejects -o table with the command's own error instead of printing", () =>
  Effect.gen(function* () {
    const result = yield* runSupabaseEffect([
      "skill",
      "display",
      "-o",
      "table",
      "--output-format",
      "json",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("# Supabase CLI: agent overview");
    const envelope = yield* Schema.decodeEffect(Schema.fromJsonString(ErrorEnvelope))(
      result.stdout,
    );
    expect(envelope.error.message).toBe(unsupportedOutputFlagMessage("skill display"));
  }).pipe(Effect.provide(BunServices.layer)),
);
