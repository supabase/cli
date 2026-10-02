import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

const storedSigningKeysJson = Schema.fromJsonString(Schema.Unknown);

const makeProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-gen-signing-key-e2e-" });
  yield* fs.makeDirectory(path.join(projectDir, "supabase"), { recursive: true });
  yield* fs.writeFileString(
    path.join(projectDir, "supabase", "config.toml"),
    '[auth]\nsigning_keys_path = "./signing_keys.json"\n',
  );
  const keysPath = path.join(projectDir, "supabase", "signing_keys.json");
  yield* fs.writeFileString(keysPath, "[]\n");
  return { projectDir, keysPath };
});

/**
 * Golden-path e2e exercising the real compiled-binary boundary: the actual production runtime
 * layer, not the mocked `Stdin` the integration suite provides. Per-branch prompt/format
 * coverage lives in the integration suite.
 */
describe("supabase gen signing-key", () => {
  it.live(
    "declines the overwrite on a piped 'n' without crashing or writing the file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { projectDir, keysPath } = yield* makeProject;
        const { exitCode, stderr } = yield* runSupabaseEffect(["gen", "signing-key"], {
          cwd: projectDir,
          stdin: "n\n",
        });
        expect(exitCode).toBe(1);
        expect(stderr).toContain("context canceled");
        expect(stderr).not.toContain("Try rerunning the command with --debug");
        expect(stderr).not.toContain("Service not found");
        const saved = yield* fs.readFileString(keysPath);
        expect(yield* Schema.decodeEffect(storedSigningKeysJson)(saved)).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    { timeout: E2E_TIMEOUT_MS },
  );

  it.live(
    "overwrites on a piped 'y'",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { projectDir, keysPath } = yield* makeProject;
        const { exitCode, stderr } = yield* runSupabaseEffect(["gen", "signing-key"], {
          cwd: projectDir,
          stdin: "y\n",
        });
        expect(exitCode).toBe(0);
        expect(stderr).toContain("JWT signing key appended to:");
        const saved = yield* fs.readFileString(keysPath);
        expect(yield* Schema.decodeEffect(storedSigningKeysJson)(saved)).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    { timeout: E2E_TIMEOUT_MS },
  );
});
