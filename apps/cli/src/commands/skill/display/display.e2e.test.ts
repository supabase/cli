import { expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Schema } from "effect";

import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

const JsonEnvelope = Schema.Struct({
  error: Schema.Struct({ message: Schema.String, suggestion: Schema.String }),
});

it.live("prints the embedded overview as raw markdown", () =>
  Effect.gen(function* () {
    const result = yield* runSupabaseEffect(["skill", "display"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("# Supabase CLI: agent overview");
    expect(result.stderr).toBe("");
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
