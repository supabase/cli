import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { runSupabaseEffect, stripAnsi } from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase start", () => {
  // An unreachable `DOCKER_HOST` forces a fast, deterministic failure regardless of whether a
  // real Docker daemon is reachable in the sandbox.
  it.live(
    "prints the invalid --exclude warning then fails cleanly on the Docker call",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "sb-start-e2e-" });
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["start", "--exclude", "bogus"],
          {
            cwd: projectDir,
            env: { DOCKER_HOST: "tcp://127.0.0.1:1" },
          },
        );

        expect(stripAnsi(stderr), `stdout:\n${stdout}\nstderr:\n${stderr}`).toContain(
          "WARNING: The following container names are not valid to exclude: bogus",
        );
        expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).not.toBe(0);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
});
