import { describe, expect, it } from "vitest";
import { classifyCliErrorActionability } from "../shared/telemetry/error-actionability.ts";
import { RemovedSurfaceError } from "./removed-command.ts";

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
