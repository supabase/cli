import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../../tests/helpers/cli.ts";

describe("legacy hello", () => {
  test("prints hello legacy", async () => {
    const { exitCode, stdout, stderr } = await runSupabase(["hello"], {
      entrypoint: "legacy",
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("hello legacy");
  });
});
