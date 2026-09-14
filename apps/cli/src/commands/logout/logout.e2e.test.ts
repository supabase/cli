import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect, stripAnsi, tempHomeScoped } from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const VALID_TOKEN = "sbp_" + "a".repeat(40);

// The e2e harness points SUPABASE_HOME at the isolated home dir, so the fallback
// token file lives at <SUPABASE_HOME>/access-token.
const seedTokenFile = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tokenPath = path.join(home, "access-token");
    yield* fs.writeFileString(tokenPath, VALID_TOKEN, { mode: 0o600 });
    return tokenPath;
  });

describe("supabase logout", () => {
  // Under SUPABASE_NO_KEYRING=1, keyring delete is unsupported, so logout removes the file
  // token yet still reports "not logged in" and exits 0.
  it.live(
    "logout --yes removes a file token but reports not-logged-in under no-keyring",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* tempHomeScoped;
        const tokenPath = yield* seedTokenFile(home.dir);
        const { exitCode, stderr } = yield* runSupabaseEffect(["logout", "--yes"], {
          home: home.dir,
          // Pin ambient runner state out of the child; the harness's SUPABASE_NO_KEYRING=1
          // is load-bearing safety here (without it `logout --yes` sweeps the real keychain).
          env: { HOME: home.dir, SUPABASE_ACCESS_TOKEN: undefined, SUPABASE_PROFILE: undefined },
        });
        expect(exitCode).toBe(0);
        expect(stderr).toContain("You were not logged in, nothing to do.");
        const tokenFileExists = yield* fs.exists(tokenPath);
        expect(tokenFileExists).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "declining the logout prompt prints only context canceled, no --debug hint",
    () =>
      Effect.gen(function* () {
        const home = yield* tempHomeScoped;
        yield* seedTokenFile(home.dir);
        const { exitCode, stderr } = yield* runSupabaseEffect(["logout"], {
          home: home.dir,
          env: {
            HOME: home.dir,
            SUPABASE_ACCESS_TOKEN: undefined,
            SUPABASE_PROFILE: undefined,
            SUPABASE_YES: undefined,
          },
          stdin: "n\n",
        });
        expect(exitCode).toBe(1);
        const lines = stripAnsi(stderr).trimEnd().split("\n");
        expect(lines.at(-1)).toBe("context canceled");
        expect(stderr).not.toContain("Try rerunning the command with --debug");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "logout --yes with no token reports not-logged-in and exits 0",
    () =>
      Effect.gen(function* () {
        const home = yield* tempHomeScoped;
        const { exitCode, stderr } = yield* runSupabaseEffect(["logout", "--yes"], {
          home: home.dir,
          env: { HOME: home.dir, SUPABASE_ACCESS_TOKEN: undefined, SUPABASE_PROFILE: undefined },
        });
        expect(exitCode).toBe(0);
        expect(stderr).toContain("You were not logged in, nothing to do.");
      }).pipe(Effect.scoped),
    E2E_TIMEOUT_MS,
  );
});
