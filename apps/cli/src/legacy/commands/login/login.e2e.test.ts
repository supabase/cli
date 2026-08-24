import { describe, expect, test } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";

import { makeTempHome, runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const VALID_TOKEN = "sbp_" + "a".repeat(40);
const path = Effect.runSync(Path.Path.pipe(Effect.provide(BunServices.layer)));

describe("supabase login (legacy)", () => {
  // Golden path: --token persists the access token and reports success. The e2e
  // harness sets SUPABASE_NO_KEYRING=1 and points SUPABASE_HOME at the isolated
  // home dir, so the token lands in <SUPABASE_HOME>/access-token rather than the
  // OS keyring.
  test(
    "login --token persists the token and prints the logged-in message",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      makeTempHome().then((home) =>
        runSupabase(["login", "--token", VALID_TOKEN], {
          entrypoint: "legacy",
          home: home.dir,
          env: { HOME: home.dir },
        }).then((result) =>
          Effect.runPromise(
            Effect.gen(function* () {
              yield* Effect.void;
              const fs = yield* FileSystem.FileSystem;
              expect(result.exitCode).toBe(0);
              expect(result.stdout).toContain("You are now logged in. Happy coding!");
              expect(yield* fs.exists(path.join(home.dir, "access-token"))).toBe(true);
            }).pipe(
              Effect.provide(BunServices.layer),
              Effect.ensuring(Effect.tryPromise(() => home[Symbol.asyncDispose]())),
            ),
          ),
        ),
      ),
  );

  // Non-TTY with no token cannot use the automatic flow.
  test(
    "login with no token in a non-TTY exits non-zero with the missing-token message",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      makeTempHome().then((home) =>
        runSupabase(["login"], {
          entrypoint: "legacy",
          home: home.dir,
          env: { HOME: home.dir },
        }).then((result) =>
          Effect.runPromise(
            Effect.gen(function* () {
              yield* Effect.void;
              expect(result.exitCode).not.toBe(0);
              expect(`${result.stdout}${result.stderr}`).toContain(
                "Cannot use automatic login flow",
              );
            }).pipe(
              Effect.provide(BunServices.layer),
              Effect.ensuring(Effect.tryPromise(() => home[Symbol.asyncDispose]())),
            ),
          ),
        ),
      ),
  );
});
