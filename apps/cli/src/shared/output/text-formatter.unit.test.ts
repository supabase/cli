import { CliError } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";
import { textCliOutputFormatter } from "./text-formatter.ts";

describe("textCliOutputFormatter", () => {
  it("preserves default parser suggestions for unchanged errors", () => {
    const formatter = textCliOutputFormatter();

    const text = formatter.formatErrors([
      new CliError.UnrecognizedOption({
        option: "--pla",
        command: ["supabase", "projects", "create"],
        suggestions: ["--plan"],
      }),
    ]);

    expect(text).toContain("Unrecognized flag: --pla in command supabase projects create");
    expect(text).toContain("Did you mean this?");
    expect(text).toContain("--plan");
  });
});
