import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect, stripAnsi } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase migration new", () => {
  it.live(
    "copies piped SQL and prints one path relative to an explicit workdir",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "sb-mig-new-e2e-" });
        const workdir = path.join(cwd, "workspace");
        yield* fs.makeDirectory(workdir);
        const stdin = "select 1;\n";

        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          [
            "migration",
            "new",
            "nested/create_widgets",
            "--workdir",
            workdir,
            "--output-format",
            "text",
          ],
          { cwd, stdin },
        );

        expect(exitCode).toBe(0);
        expect(stderr).toBe("");
        const migrations = path.join(workdir, "supabase", "migrations");
        const dirs = yield* fs.readDirectory(migrations);
        expect(dirs).toHaveLength(1);
        expect(dirs[0]).toMatch(/^\d{14}_nested$/u);
        const relative = path.join("supabase", "migrations", `${dirs[0]}`, "create_widgets.sql");
        expect(stripAnsi(stdout)).toBe(`Created new migration at ${relative}\n`);
        expect(yield* fs.readFileString(path.join(workdir, relative))).toBe(stdin);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
});
