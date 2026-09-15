import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect, withTempHome } from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const VALID_TOKEN = "sbp_" + "a".repeat(40);

describe("supabase login", () => {
  // The e2e harness sets SUPABASE_NO_KEYRING=1, so the token lands in
  // <SUPABASE_HOME>/access-token rather than the OS keyring.
  it.live(
    "login --token persists the token and prints the logged-in message",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          const { exitCode, stdout } = yield* runSupabaseEffect(["login", "--token", VALID_TOKEN], {
            home: home.dir,
            env: { HOME: home.dir },
          });

          expect(exitCode).toBe(0);
          expect(stdout).toContain("You are now logged in. Happy coding!");
          const tokenFileExists = yield* fs.exists(path.join(home.dir, "access-token"));
          expect(tokenFileExists).toBe(true);
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "login with no token in a non-TTY exits non-zero with the missing-token message",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const { exitCode, stdout, stderr } = yield* runSupabaseEffect(["login"], {
            home: home.dir,
            // The runner may export a real token/profile; this test needs both absent.
            env: { HOME: home.dir, SUPABASE_ACCESS_TOKEN: undefined, SUPABASE_PROFILE: undefined },
          });

          expect(exitCode).not.toBe(0);
          expect(`${stdout}${stderr}`).toContain("Cannot use automatic login flow");
        }),
      ),
    E2E_TIMEOUT_MS,
  );
});
