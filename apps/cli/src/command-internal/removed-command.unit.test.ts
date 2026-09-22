import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { classifyCliErrorActionability } from "../shared/telemetry/error-actionability.ts";
import { commandRuntimeLayer } from "../shared/runtime/command-runtime.layer.ts";
import { mockTelemetryStateTracked } from "../../tests/helpers/command-mocks.ts";
import { removedCommand, removedFlag, RemovedSurfaceError } from "./removed-command.ts";

describe("RemovedSurfaceError actionability", () => {
  it("classifies a removed command with the :removed_command fingerprint suffix", () => {
    const classified = classifyCliErrorActionability(
      new RemovedSurfaceError({
        message: "supabase db branch create was removed.",
        suggestion: "Use `supabase branches --help` instead.",
        kind: "command",
      }),
    );
    expect(classified).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      has_suggestion: true,
      suggestion_type: "run_command",
    });
    expect(classified.error_fingerprint).toBe("tag:RemovedSurfaceError:removed_command");
  });

  it("classifies a removed flag with the :removed_flag fingerprint suffix", () => {
    const classified = classifyCliErrorActionability(
      new RemovedSurfaceError({
        message: "--use-pg-schema was removed.",
        suggestion: "Use the default migra engine or --use-pg-delta.",
        kind: "flag",
      }),
    );
    expect(classified).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
      has_suggestion: true,
      suggestion_type: "run_command",
    });
    expect(classified.error_fingerprint).toBe("tag:RemovedSurfaceError:removed_flag");
  });

  it("classifies a field-less probe instance without throwing", () => {
    const probe = Object.create(RemovedSurfaceError.prototype) as RemovedSurfaceError;
    expect(() => classifyCliErrorActionability(probe)).not.toThrow();
    const classified = classifyCliErrorActionability(probe);
    expect(classified.error_fingerprint.endsWith(":removed_command")).toBe(true);
    expect(classified).toMatchObject({
      error_kind: "user_actionable",
      error_category: "invalid_input",
    });
  });
});

describe("TelemetryState flush", () => {
  it.effect("flushes on a removedCommand failure", () => {
    const telemetry = mockTelemetryStateTracked();
    return removedCommand("Use `supabase branches --help` instead.").pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          expect(telemetry.flushed).toBe(true);
          expect(telemetry.flushCount).toBe(1);
        }),
      ),
      Effect.provide(commandRuntimeLayer(["db", "branch", "create"])),
      Effect.provide(telemetry.layer),
    );
  });

  it.effect("flushes on a removedFlag failure", () => {
    const telemetry = mockTelemetryStateTracked();
    return removedFlag("--use-pg-schema", "Use the default migra engine or --use-pg-delta.").pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          expect(telemetry.flushed).toBe(true);
          expect(telemetry.flushCount).toBe(1);
        }),
      ),
      Effect.provide(telemetry.layer),
    );
  });
});
