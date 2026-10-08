import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { runSupabaseEffect } from "../../../tests/helpers/cli.ts";

/**
 * Only a genuine subprocess run proves the shipped binary's real OS exit code — the
 * classification logic itself is covered by `run.unit.test.ts` and `run.integration.test.ts`.
 */
describe("CLI process exit codes (CLI-1906)", () => {
  it.live("bare `branches` (no subcommand, no --help) exits 0", () =>
    Effect.gen(function* () {
      const { exitCode } = yield* runSupabaseEffect(["branches"]);
      expect(exitCode).toBe(0);
    }),
  );

  it.live("a genuine parse error still exits 1", () =>
    Effect.gen(function* () {
      const { exitCode } = yield* runSupabaseEffect(["branches", "--this-flag-does-not-exist"], {});
      expect(exitCode).toBe(1);
    }),
  );
});

/**
 * `withoutParseErrorHelpDump` (`run.ts`) is already covered against a real command definition,
 * in-process, by `run.integration.test.ts` — this is the one case that observes the real
 * subprocess boundary: whether stdout/stderr stay separated and the error text isn't duplicated.
 */
describe("CLI required-flag/choice parse errors (CLI-1901)", () => {
  it.live(
    "an unrecognized flag: stdout stays clean, the help/usage content and the single error line land on stderr with no duplicate",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect([
          "branches",
          "--this-flag-does-not-exist",
        ]);
        expect(exitCode).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("USAGE");
        const occurrences =
          stderr.split("Unrecognized flag: --this-flag-does-not-exist").length - 1;
        expect(occurrences).toBe(1);
        expect(
          stderr
            .trim()
            .endsWith("Try rerunning the command with --debug to troubleshoot the error."),
        ).toBe(true);
      }),
  );
});

/** Real-subprocess proof of the `afterSuccess` wiring; everything else lives in `upgrade-notice.unit.test.ts`. */
describe("CLI upgrade notice (#5853)", () => {
  const upgradeNoticeWorkdir = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-upgrade-notice-e2e-" });
    yield* fs.makeDirectory(path.join(workdir, "supabase", ".temp"), { recursive: true });
    yield* fs.writeFileString(
      path.join(workdir, "supabase", "config.toml"),
      'project_id = "demo"\n',
    );
    yield* fs.writeFileString(path.join(workdir, "supabase", ".temp", "cli-latest"), "v99.99.99");
    return workdir;
  });

  it.live("prints the cached notice on success and honors SUPABASE_NO_UPDATE_NOTIFIER", () =>
    Effect.gen(function* () {
      const workdir = yield* upgradeNoticeWorkdir;

      const enabled = yield* runSupabaseEffect(["branches"], {
        cwd: workdir,
        env: { SUPABASE_NO_UPDATE_NOTIFIER: "0" },
      });
      expect(enabled.exitCode).toBe(0);
      expect(enabled.stderr).toContain("A new version of Supabase CLI is available: v99.99.99");

      const suppressed = yield* runSupabaseEffect(["branches"], { cwd: workdir });
      expect(suppressed.exitCode).toBe(0);
      expect(suppressed.stderr).not.toContain("A new version of Supabase CLI is available");

      // `--help` exits through the plain-success branch, bare `branches` through the
      // clean-ShowHelp one — both call sites must fire.
      const helped = yield* runSupabaseEffect(["branches", "--help"], {
        cwd: workdir,
        env: { SUPABASE_NO_UPDATE_NOTIFIER: "0" },
      });
      expect(helped.exitCode).toBe(0);
      expect(helped.stderr).toContain("A new version of Supabase CLI is available: v99.99.99");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("a failing command exits non-zero and prints no notice", () =>
    Effect.gen(function* () {
      const workdir = yield* upgradeNoticeWorkdir;

      const { exitCode, stderr } = yield* runSupabaseEffect(["branches", "--nope"], {
        cwd: workdir,
        env: { SUPABASE_NO_UPDATE_NOTIFIER: "0" },
      });
      expect(exitCode).toBe(1);
      expect(stderr).not.toContain("A new version of Supabase CLI is available");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("keeps the upgrade notice before a native command suggestion", () =>
    Effect.gen(function* () {
      const workdir = yield* upgradeNoticeWorkdir;

      const { exitCode, stderr } = yield* runSupabaseEffect(["gen", "signing-key"], {
        cwd: workdir,
        env: { SUPABASE_NO_UPDATE_NOTIFIER: "0" },
      });

      expect(exitCode).toBe(0);
      const noticeIndex = stderr.indexOf("A new version of Supabase CLI is available");
      const suggestionIndex = stderr.indexOf("To enable JWT signing keys in your local project:");
      expect(noticeIndex).toBeGreaterThanOrEqual(0);
      expect(suggestionIndex).toBeGreaterThan(noticeIndex);

      const suppressed = yield* runSupabaseEffect(["gen", "signing-key"], {
        cwd: workdir,
      });
      expect(suppressed.exitCode).toBe(0);
      expect(suppressed.stderr).not.toContain("A new version of Supabase CLI is available");
      expect(suppressed.stderr).toContain("To enable JWT signing keys in your local project:");
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
