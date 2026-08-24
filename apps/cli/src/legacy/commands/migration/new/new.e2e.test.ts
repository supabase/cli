import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabase, stripAnsi } from "../../../../../tests/helpers/cli.ts";
import { useLegacyTempWorkdir } from "../../../../../tests/helpers/legacy-mocks.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase migration new (legacy)", () => {
  const workdir = useLegacyTempWorkdir("sb-mig-new-e2e-");

  // Primary golden path: a real subprocess creates the migration file under the
  // working directory and prints the workdir-relative path. No infra required.
  test(
    "creates a timestamped migration file and prints its path",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      runSupabase(["migration", "new", "create_widgets"], {
        entrypoint: "legacy",
        cwd: workdir.current,
      }).then(({ exitCode, stdout }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            expect(exitCode).toBe(0);
            const files = yield* fs.readDirectory(
              path.join(workdir.current, "supabase", "migrations"),
            );
            expect(files).toHaveLength(1);
            expect(files[0]).toMatch(/^\d{14}_create_widgets\.sql$/u);
            expect(stripAnsi(stdout)).toContain(
              `Created new migration at supabase/migrations/${files[0]}`,
            );
          }).pipe(Effect.provide(BunServices.layer)),
        ),
      ),
  );
});
