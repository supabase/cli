import { BunServices } from "@effect/platform-bun";
import { beforeEach, describe, expect, test } from "vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabase, stripAnsi } from "../../../../../tests/helpers/cli.ts";
import { useLegacyTempWorkdir } from "../../../../../tests/helpers/legacy-mocks.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase migration fetch (legacy)", () => {
  const workdir = useLegacyTempWorkdir("sb-mig-fetch-e2e-");
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(workdir.current, "supabase", "migrations"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(workdir.current, "supabase", "config.toml"),
          "[db]\nport = 54322\n",
        );
        yield* fs.writeFileString(
          path.join(workdir.current, "supabase", "migrations", "20240101000000_existing.sql"),
          "select 1;\n",
        );
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );

  // Real-subprocess guard for the production Stdin wiring + confirm prompt: a piped
  // answer to the overwrite prompt must actually be read, not auto-defaulted. A declined
  // `n` cancels before connecting, so no DB is required. This is the boundary in-process
  // tests cannot cover — they inject a mock Stdin, which masked a missing-service bug
  // where the migration DB runtime never provided the real stdin layer.
  test(
    "reads a piped 'n' answer to the overwrite prompt and cancels",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      runSupabase(["migration", "fetch", "--local"], {
        entrypoint: "legacy",
        cwd: workdir.current,
        stdin: "n\n",
      }).then(({ exitCode, stderr }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            // Declined → cancelled (exit 1), and the prompt label reached stderr.
            expect(exitCode).toBe(1);
            expect(stripAnsi(stderr)).toContain("[Y/n]");
            // A declined prompt renders a lone `context canceled` line, with NO
            // `SuggestDebugFlag` troubleshooting hint appended. CLI-1973.
            const lines = stripAnsi(stderr).trimEnd().split("\n");
            expect(lines.at(-1)).toBe("context canceled");
            expect(stderr).not.toContain("Try rerunning the command with --debug");
            // The existing file was NOT overwritten — the piped answer was honored.
            expect(
              yield* fs.readDirectory(path.join(workdir.current, "supabase", "migrations")),
            ).toEqual(["20240101000000_existing.sql"]);
          }).pipe(Effect.provide(BunServices.layer)),
        ),
      ),
  );
});
