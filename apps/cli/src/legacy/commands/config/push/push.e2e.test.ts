import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const TEST_PROJECT_REF = "abcdefghijklmnopqrst";
const TEST_TOKEN = "sbp_" + "a".repeat(40);

/**
 * Golden-path e2e: exercises the real compiled-binary boundary for the only
 * network-free failure path in `config push` — a malformed `supabase/config.toml`
 * aborts before any API call. Validates that `Command.provide` + the runtime
 * layer + `withJsonErrorHandling` surface the parse error with exit code 1.
 * Per-service diff/output parity is covered by the unit + integration suites.
 */
describe("supabase config push (legacy)", () => {
  let projectDir: string;

  beforeAll(() => {
    return Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        projectDir = yield* fs.makeTempDirectory({ prefix: "supabase-config-push-e2e-" });
        yield* fs.makeDirectory(path.join(projectDir, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(projectDir, "supabase", "config.toml"), "malformed");
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });

  afterAll(() => {
    return Effect.runPromise(
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.remove(projectDir, { recursive: true })),
        Effect.provide(BunServices.layer),
      ),
    );
  });

  test(
    "aborts with exit 1 on a malformed config.toml before any network call",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      runSupabase(["config", "push", "--project-ref", TEST_PROJECT_REF], {
        entrypoint: "legacy",
        cwd: projectDir,
        env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
      }).then(({ exitCode, stdout, stderr }) => {
        expect(exitCode).toBe(1);
        expect(`${stdout}${stderr}`).toContain("config.toml");
      }),
  );
});
