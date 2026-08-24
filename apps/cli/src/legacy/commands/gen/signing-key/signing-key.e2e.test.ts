import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path, Schema } from "effect";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const path = Effect.runSync(Path.Path.pipe(Effect.provide(BunServices.layer)));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Golden-path e2e for CLI-1865: exercises the real compiled-binary boundary —
 * `signing-key.command.ts`'s actual production runtime layer, not the mocked
 * `Stdin` the integration suite provides via `Layer.succeed`. A missing
 * `stdinLayer` in that composition only surfaces as a "Service not found" defect
 * at this boundary (see the legacy CLAUDE.md Go Parity Checklist item 5). Per-branch
 * prompt/format coverage lives in the integration suite.
 */
describe("supabase gen signing-key (legacy)", () => {
  let projectDir: string;

  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const temp = yield* fs.makeTempDirectory({ prefix: "supabase-gen-signing-key-e2e-" });
        projectDir = temp;
        yield* fs.makeDirectory(path.join(projectDir, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(projectDir, "supabase", "config.toml"),
          '[auth]\nsigning_keys_path = "./signing_keys.json"\n',
        );
        yield* fs.writeFileString(path.join(projectDir, "supabase", "signing_keys.json"), "[]\n");
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );

  afterEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(projectDir, { recursive: true });
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );

  test(
    "declines the overwrite on a piped 'n' without crashing or writing the file",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      runSupabase(["gen", "signing-key"], {
        entrypoint: "legacy",
        cwd: projectDir,
        stdin: "n\n",
      }).then((result) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain("context canceled");
            expect(result.stderr).not.toContain("Try rerunning the command with --debug");
            expect(result.stderr).not.toContain("Service not found");
            const saved = yield* fs.readFileString(
              path.join(projectDir, "supabase", "signing_keys.json"),
            );
            expect(decodeJson(saved)).toEqual([]);
          }).pipe(Effect.provide(BunServices.layer)),
        ),
      ),
  );

  test("overwrites on a piped 'y'", { timeout: E2E_TIMEOUT_MS }, () =>
    runSupabase(["gen", "signing-key"], {
      entrypoint: "legacy",
      cwd: projectDir,
      stdin: "y\n",
    }).then((result) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toContain("JWT signing key appended to:");
          const saved = yield* fs.readFileString(
            path.join(projectDir, "supabase", "signing_keys.json"),
          );
          expect(decodeJson(saved)).toHaveLength(1);
        }).pipe(Effect.provide(BunServices.layer)),
      ),
    ),
  );
});
