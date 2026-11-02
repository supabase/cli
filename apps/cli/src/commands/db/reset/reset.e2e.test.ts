import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect, stripAnsi } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase db reset", () => {
  // Docker-free: the confirmation fires after config load and before any connection is dialed.
  it.live(
    "refuses a remote reset that cannot prompt, even with a piped answer, and points at --yes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "sb-db-reset-e2e-" });
        yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "config.toml"),
          "[db]\nport = 54322\n",
        );
        const { exitCode, stderr } = yield* runSupabaseEffect(
          ["db", "reset", "--remote=postgresql://postgres:postgres@127.0.0.1:9999/postgres"],
          { cwd: workdir, stdin: "y\n" },
        );
        expect(exitCode).toBe(1);
        const text = stripAnsi(stderr);
        expect(text).toContain("Confirmation required");
        expect(text).toContain("--yes");
        expect(text).not.toContain("Resetting remote database");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
});
