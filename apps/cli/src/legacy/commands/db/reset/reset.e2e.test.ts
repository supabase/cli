import { BunServices } from "@effect/platform-bun";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabase, stripAnsi } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase db reset (legacy)", () => {
  let workdir: string;
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        workdir = yield* fs.makeTempDirectory({ prefix: "sb-db-reset-e2e-" });
        yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "config.toml"),
          "[db]\nport = 54322\n",
        );
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );
  afterEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(workdir, { recursive: true });
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );

  // Docker-free: the destructive remote-reset confirmation fires after the config
  // load and BEFORE any connection is dialed, so a piped decline exits without a
  // database. Declining prints an established output contract: a single
  // `context canceled` line on stderr and exit 1, with NO `--debug`
  // troubleshooting hint.
  test(
    "declining the remote reset prompt prints only context canceled, no --debug hint",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      runSupabase(
        ["db", "reset", "--db-url", "postgresql://postgres:postgres@127.0.0.1:9999/postgres"],
        { entrypoint: "legacy", cwd: workdir, stdin: "n\n" },
      ).then(({ exitCode, stderr }) => {
        expect(exitCode).toBe(1);
        // The destructive confirmation (default No → `[y/N]`) actually rendered and
        // was answered — the cancellation didn't come from some other failure path.
        expect(stripAnsi(stderr)).toContain("[y/N]");
        const lines = stripAnsi(stderr).trimEnd().split("\n");
        expect(lines.at(-1)).toBe("context canceled");
        expect(stderr).not.toContain("Try rerunning the command with --debug");
      }),
  );
});
