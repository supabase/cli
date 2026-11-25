import { expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Schema } from "effect";

import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

const JsonEnvelope = Schema.Struct({
  error: Schema.Struct({ message: Schema.String, suggestion: Schema.String }),
});

const ErrorEnvelope = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });

it.live("prints the same embedded overview markdown for every output format", () =>
  Effect.gen(function* () {
    const results = yield* Effect.forEach(["text", "json", "stream-json"], (format) =>
      runSupabaseEffect(["skill", "display", "--output-format", format]),
    );

    for (const result of results) {
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^# Supabase CLI: agent overview/);
      expect(result.stdout).toContain("\n## Targeting\n");
    }
    expect(results[1]?.stdout).toBe(results[0]?.stdout);
    expect(results[2]?.stdout).toBe(results[0]?.stdout);
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
    expect(envelope.error.message).toBe(
      "skill display always prints markdown; -o/--output is not supported.",
    );
  }).pipe(Effect.provide(BunServices.layer)),
);
