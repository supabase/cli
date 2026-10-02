import { describe, expect, test } from "vitest";
import { makeTempCliProject, makeTempHome, runSupabase } from "../../tests/helpers/cli.ts";

describe("CLI feature routing", () => {
  test("reports invalid stack feature configuration during completion", async () => {
    const project = await makeTempCliProject("supabase-main-routing-e2e-");
    const home = makeTempHome();
    try {
      const result = await runSupabase(["__complete", "start", "--"], {
        cwd: project.dir,
        home: home.dir,
        env: {
          SUPABASE_EXPERIMENTAL_STACK: "yes",
          SUPABASE_WORKDIR: undefined,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("SUPABASE_EXPERIMENTAL_STACK must be 0 or 1");
    } finally {
      await project.cleanup();
      home[Symbol.dispose]();
    }
  });
});
