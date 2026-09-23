import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect, stripAnsi } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase migration fetch", () => {
  // Exercises the real Stdin wiring; in-process tests inject a mock Stdin and can't
  // catch a missing real-stdin layer.
  it.live(
    "reads a piped 'n' answer to the overwrite prompt and cancels",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "sb-mig-fetch-e2e-" });
        const migrations = path.join(workdir, "supabase", "migrations");
        yield* fs.makeDirectory(migrations, { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "config.toml"),
          "[db]\nport = 54322\n",
        );
        yield* fs.writeFileString(
          path.join(migrations, "20240101000000_existing.sql"),
          "select 1;\n",
        );

        const { exitCode, stderr } = yield* runSupabaseEffect(["migration", "fetch", "--local"], {
          cwd: workdir,
          stdin: "n\n",
        });

        expect(exitCode).toBe(1);
        expect(stripAnsi(stderr)).toContain("[Y/n]");
        // A declined prompt exits with a lone "context canceled" line and no --debug hint.
        const lines = stripAnsi(stderr).trimEnd().split("\n");
        expect(lines.at(-1)).toBe("context canceled");
        expect(stderr).not.toContain("Try rerunning the command with --debug");
        expect(yield* fs.readDirectory(migrations)).toEqual(["20240101000000_existing.sql"]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
});
