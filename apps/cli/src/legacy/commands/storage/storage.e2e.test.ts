import { BunServices } from "@effect/platform-bun";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

/**
 * Golden-path e2e for the `storage` group: the real compiled-binary surface and
 * the parser boundary for the persistent `--linked`/`--local` flags. Object
 * list/copy/move/remove parity is covered by the integration + unit suites
 * (they don't need a live local stack); these only exercise what the in-process
 * suites bypass.
 */
describe("supabase storage (legacy)", () => {
  let projectDir: string;

  beforeAll(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        projectDir = yield* fs.makeTempDirectory({ prefix: "supabase-storage-e2e-" });
        yield* fs.makeDirectory(path.join(projectDir, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(projectDir, "supabase", "config.toml"),
          'project_id = "test"\n',
        );
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );

  afterAll(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(projectDir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );

  test("lists the four subcommands in --help", { timeout: E2E_TIMEOUT_MS }, () =>
    runSupabase(["storage", "--help"], {
      entrypoint: "legacy",
      cwd: projectDir,
    }).then(({ exitCode, stdout }) => {
      expect(exitCode).toBe(0);
      for (const sub of ["ls", "cp", "mv", "rm"]) {
        expect(stdout).toContain(sub);
      }
    }),
  );

  test("rejects passing both --local and --linked", { timeout: E2E_TIMEOUT_MS }, () => {
    // The experimental gate runs BEFORE the mutex check, so --experimental
    // must be set here to reach the mutex check at all — otherwise the
    // experimental-gate error wins (see the next test).
    return runSupabase(["storage", "ls", "--local", "--linked", "ss:///", "--experimental"], {
      entrypoint: "legacy",
      cwd: projectDir,
    }).then(({ exitCode, stdout, stderr }) => {
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain(
        "if any flags in the group [linked local] are set none of the others can be",
      );
    });
  });

  test("rejects storage subcommands without --experimental", { timeout: E2E_TIMEOUT_MS }, () => {
    // `storage` is an experimental command group; running it without
    // --experimental is rejected by the experimental gate.
    return runSupabase(["storage", "ls", "ss:///", "--local"], {
      entrypoint: "legacy",
      cwd: projectDir,
    }).then(({ exitCode, stdout, stderr }) => {
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain(
        "must set the --experimental flag to run this command",
      );
    });
  });

  test("accepts --local after the subcommand token", { timeout: E2E_TIMEOUT_MS }, () => {
    // `--linked`/`--local` are per-leaf flags (Effect CLI requires unique
    // global-flag names tree-wide and `seed` owns them), so they follow the
    // subcommand. With --experimental it parses and passes the gate; there's no
    // live local stack so it fails to connect — but it must PARSE (no
    // "Unrecognized flag") and must NOT be blocked by the experimental gate.
    return runSupabase(["storage", "ls", "ss:///", "--local", "--experimental"], {
      entrypoint: "legacy",
      cwd: projectDir,
    }).then(({ stdout, stderr }) => {
      const combined = `${stdout}${stderr}`;
      expect(combined).not.toContain("Unrecognized flag");
      expect(combined).not.toContain("must set the --experimental flag");
    });
  });
});
