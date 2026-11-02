import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect, stripAnsi } from "../../../tests/helpers/cli.ts";

// A well-formed token bypasses the auth layer's eager `SUPABASE_ACCESS_TOKEN` check, so the run
// reaches this command's own handler instead of failing on "Access token not provided" first.
const TEST_TOKEN = "sbp_" + "a".repeat(40);

describe("pull CLI surface", () => {
  it.live(
    "plain `supabase pull` parses its flags and fails on target resolution, not argument parsing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-pull-e2e-flags-" });
        // A loadable config.toml with no project_id/ref-file state is required to get past config
        // loading and into `resolveConfigTarget`, which this test exercises.
        yield* fs.makeDirectory(path.join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(cwd, "supabase", "config.toml"),
          'project_id = "test"\n',
        );

        const { exitCode, stderr } = yield* runSupabaseEffect(["pull"], {
          cwd,
          env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
        });
        const cleanStderr = stripAnsi(stderr);
        expect(cleanStderr).not.toContain("required flag");
        expect(cleanStderr).not.toContain("Unrecognized flag");
        expect(cleanStderr).toContain("Cannot find project ref. Have you run supabase link?");
        expect(exitCode).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("`supabase pull -o json` is rejected by the handler, pointing at --output-format", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-pull-e2e-output-" });

      const { exitCode, stderr } = yield* runSupabaseEffect(["pull", "-o", "json"], {
        cwd,
        env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
      });
      const cleanStderr = stripAnsi(stderr);
      expect(cleanStderr).not.toContain("Unrecognized flag");
      expect(cleanStderr).not.toContain("invalid choice");
      expect(cleanStderr).toContain(
        "the -o/--output flag is not supported by pull; use --output-format json|stream-json instead.",
      );
      expect(exitCode).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
