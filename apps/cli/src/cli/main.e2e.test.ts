import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
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
          expect(result.stderr).toContain(
            'Invalid SUPABASE_EXPERIMENTAL_STACK="yes" (sets experimental.stack): expected true or false.',
          );
        }),
      ),
    ),
  );

  it.live("names the stack opt-in when the legacy backend rejects a stack-only flag", () =>
    withTempHome((home) =>
      withTempCliProject("supabase-main-routing-e2e-", (project) =>
        Effect.gen(function* () {
          const options = {
            cwd: project.dir,
            home: home.dir,
            env: { SUPABASE_EXPERIMENTAL_STACK: undefined, SUPABASE_WORKDIR: undefined },
          };
          const hint =
            "Hint: --runtime needs the stack backend. Set SUPABASE_EXPERIMENTAL_STACK=1, or set stack = true under [experimental] in your project config and leave SUPABASE_EXPERIMENTAL_STACK unset.";

          const text = yield* runSupabaseEffect(["start", "--runtime", "native"], options);
          expect(text.exitCode).toBe(1);
          expect(text.stderr).toContain("Unrecognized flag: --runtime");
          expect(text.stderr).toContain(hint);

          const json = yield* runSupabaseEffect(
            ["start", "--runtime", "native", "--output-format", "json"],
            options,
          );
          expect(json.exitCode).toBe(1);
          const envelope = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
            json.stdout,
          );
          expect(envelope).toMatchObject({
            _tag: "Error",
            error: { code: "UnrecognizedOption", message: expect.stringContaining(hint) },
          });
        }),
      ),
    ),
  );
});
