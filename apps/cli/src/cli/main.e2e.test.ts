import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { runSupabaseEffect, withTempCliProject, withTempHome } from "../../tests/helpers/cli.ts";

describe("CLI feature routing", () => {
  it.live("reports invalid stack feature configuration during completion", () =>
    withTempHome((home) =>
      withTempCliProject("supabase-main-routing-e2e-", (project) =>
        Effect.gen(function* () {
          const result = yield* runSupabaseEffect(["__complete", "start", "--"], {
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
        }),
      ),
    ),
  );
});
