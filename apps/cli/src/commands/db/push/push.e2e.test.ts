import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const UNREACHABLE_DB_URL = "postgresql://postgres:postgres@127.0.0.1:1/postgres";

const makeVaultProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = yield* fs.makeTempDirectoryScoped({
    prefix: "supabase-db-push-skip-vault-e2e-",
  });
  yield* fs.makeDirectory(path.join(projectDir, "supabase"), { recursive: true });
  yield* fs.writeFileString(
    path.join(projectDir, "supabase", "config.toml"),
    '[db.vault]\nmy_secret = "encrypted:not-valid"\n',
  );
  return projectDir;
});

describe("supabase db push --skip-vault", () => {
  it.live(
    "fails during config loading without the flag",
    () =>
      Effect.gen(function* () {
        const projectDir = yield* makeVaultProject;
        const { exitCode, stderr } = yield* runSupabaseEffect(
          ["db", "push", "--db-url", UNREACHABLE_DB_URL],
          { cwd: projectDir },
        );
        expect(exitCode).toBe(1);
        expect(stderr).toContain("failed to parse config:");
        expect(stderr).not.toContain("Connecting to remote database...");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "reaches the database connection without decrypting vault secrets",
    () =>
      Effect.gen(function* () {
        const projectDir = yield* makeVaultProject;
        const { exitCode, stderr } = yield* runSupabaseEffect(
          ["db", "push", "--db-url", UNREACHABLE_DB_URL, "--skip-vault"],
          { cwd: projectDir },
        );
        expect(exitCode).toBe(1);
        expect(stderr).toContain("Connecting to remote database...");
        expect(stderr).toContain("failed to connect");
        expect(stderr).not.toContain("failed to parse config:");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
});
