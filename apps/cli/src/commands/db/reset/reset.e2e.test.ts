import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect, stripAnsi } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase db reset", () => {
  // Docker-free: the confirmation fires after config load and before any connection is dialed.
  it.live(
    "declining the remote reset prompt prints only context canceled, no --debug hint",
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
          ["db", "reset", "--db-url", "postgresql://postgres:postgres@127.0.0.1:9999/postgres"],
          { cwd: workdir, stdin: "n\n" },
        );
        expect(exitCode).toBe(1);
        expect(stripAnsi(stderr)).toContain("[y/N]");
        const lines = stripAnsi(stderr).trimEnd().split("\n");
        expect(lines.at(-1)).toBe("context canceled");
        expect(stderr).not.toContain("Try rerunning the command with --debug");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
});
