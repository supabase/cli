import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect, stripAnsi } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase migration new", () => {
  // Primary golden path: a real subprocess creates the migration file under the
  // working directory and prints the workdir-relative path. No infra required.
  it.live(
    "creates a timestamped migration file and prints its path",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "sb-mig-new-e2e-" });

        const { exitCode, stdout } = yield* runSupabaseEffect(
          ["migration", "new", "create_widgets"],
          { cwd: workdir },
        );

        expect(exitCode).toBe(0);
        const files = yield* fs.readDirectory(path.join(workdir, "supabase", "migrations"));
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^\d{14}_create_widgets\.sql$/u);
        expect(stripAnsi(stdout)).toContain(
          `Created new migration at supabase/migrations/${files[0]}`,
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
});
