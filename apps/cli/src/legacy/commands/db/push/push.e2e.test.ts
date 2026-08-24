import { BunServices } from "@effect/platform-bun";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const UNREACHABLE_DB_URL = "postgresql://postgres:postgres@127.0.0.1:1/postgres";

describe("supabase db push --skip-vault (legacy)", () => {
  let projectDir: string;

  beforeAll(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        projectDir = yield* fs.makeTempDirectory({
          prefix: "supabase-db-push-skip-vault-e2e-",
        });
        yield* fs.makeDirectory(path.join(projectDir, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(projectDir, "supabase", "config.toml"),
          '[db.vault]\nmy_secret = "encrypted:not-valid"\n',
        );
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );

  afterAll(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(projectDir, { recursive: true });
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );

  test("fails during config loading without the flag", { timeout: E2E_TIMEOUT_MS }, () =>
    runSupabase(["db", "push", "--db-url", UNREACHABLE_DB_URL], {
      entrypoint: "legacy",
      cwd: projectDir,
    }).then(({ exitCode, stderr }) => {
      expect(exitCode).toBe(1);
      expect(stderr).toContain("failed to parse config:");
      expect(stderr).not.toContain("Connecting to remote database...");
    }),
  );

  test(
    "reaches the database connection without decrypting vault secrets",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      runSupabase(["db", "push", "--db-url", UNREACHABLE_DB_URL, "--skip-vault"], {
        entrypoint: "legacy",
        cwd: projectDir,
      }).then(({ exitCode, stderr }) => {
        expect(exitCode).toBe(1);
        expect(stderr).toContain("Connecting to remote database...");
        expect(stderr).toContain("failed to connect");
        expect(stderr).not.toContain("failed to parse config:");
      }),
  );
});
