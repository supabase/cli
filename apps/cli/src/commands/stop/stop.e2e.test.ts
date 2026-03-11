import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../tests/helpers/cli.ts";

describe("supabase stop", () => {
  test("shows a friendly error when no local stack is running", async () => {
    const { stdout, stderr, exitCode } = await runSupabase(["stop"]);
    const output = `${stdout}${stderr}`;

    expect(exitCode).toBe(1);
    expect(output).toContain("No local Supabase stack is running for this project.");
    expect(output).toContain("Run `supabase start` in this project");
    expect(output).not.toContain("NoRunningStackError:");
    expect(output).not.toContain("StateManager.ts:");
  });
});
