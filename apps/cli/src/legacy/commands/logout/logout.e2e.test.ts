import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "vitest";
import { Effect, FileSystem, Path } from "effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeTempHomeEffect, runSupabaseEffect, stripAnsi } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const VALID_TOKEN = "sbp_" + "a".repeat(40);

// The e2e harness points SUPABASE_HOME at the isolated home dir, so the fallback
// token file lives at <SUPABASE_HOME>/access-token.
function runInTempHome<A, E>(
  use: (
    home: string,
    fs: FileSystem.FileSystem,
    path: Path.Path,
  ) => Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* Effect.acquireRelease(
          makeTempHomeEffect,
          (tempHome) => tempHome.disposeEffect,
        );
        return yield* use(home.dir, fs, path);
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  );
}

function seedTokenFile(home: string, fs: FileSystem.FileSystem, path: Path.Path) {
  const tokenPath = path.join(home, "access-token");
  return fs.writeFileString(tokenPath, VALID_TOKEN, { mode: 0o600 }).pipe(Effect.as(tokenPath));
}

describe("supabase logout (legacy)", () => {
  // Deliberate Go quirk (parity note 1): under SUPABASE_NO_KEYRING=1 the profile
  // keyring delete is unsupported, so logout removes the file token yet still
  // reports "not logged in" and exits 0.
  test(
    "logout --yes removes a file token but reports not-logged-in under no-keyring",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      runInTempHome((home, fs, path) =>
        Effect.gen(function* () {
          const tokenPath = yield* seedTokenFile(home, fs, path);
          const { exitCode, stderr } = yield* runSupabaseEffect(["logout", "--yes"], {
            entrypoint: "legacy",
            home,
            env: { HOME: home },
          });
          expect(exitCode).toBe(0);
          expect(stderr).toContain("You were not logged in, nothing to do.");
          expect(yield* fs.exists(tokenPath)).toBe(false);
        }),
      ),
  );

  // Declining the confirmation must print a single `context canceled` line on
  // stderr and exit 1, with NO `--debug` troubleshooting hint —
  // `recoverAndExit` skips `SuggestDebugFlag` for `context.Canceled`
  // (apps/cli-go/cmd/root.go:287-303). CLI-1973.
  test(
    "declining the logout prompt prints only context canceled, no --debug hint",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      runInTempHome((home, fs, path) =>
        Effect.gen(function* () {
          yield* seedTokenFile(home, fs, path);
          const { exitCode, stderr } = yield* runSupabaseEffect(["logout"], {
            entrypoint: "legacy",
            home,
            env: { HOME: home },
            stdin: "n\n",
          });
          expect(exitCode).toBe(1);
          const lines = stripAnsi(stderr).trimEnd().split("\n");
          expect(lines.at(-1)).toBe("context canceled");
          expect(stderr).not.toContain("Try rerunning the command with --debug");
        }),
      ),
  );

  // No token at all: same not-logged-in message, exit 0.
  test(
    "logout --yes with no token reports not-logged-in and exits 0",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      runInTempHome((home) =>
        Effect.gen(function* () {
          const { exitCode, stderr } = yield* runSupabaseEffect(["logout", "--yes"], {
            entrypoint: "legacy",
            home,
            env: { HOME: home },
          });
          expect(exitCode).toBe(0);
          expect(stderr).toContain("You were not logged in, nothing to do.");
        }),
      ),
  );
});
