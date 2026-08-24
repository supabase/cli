import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import type * as PlatformError from "effect/PlatformError";
import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../tests/helpers/cli.ts";

const run = (args: string[], options?: Parameters<typeof runSupabase>[1]) =>
  Effect.promise(() => runSupabase(args, options));

const withUpgradeFixture = (
  program: (workdir: string) => Effect.Effect<void, never, never>,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-upgrade-notice-e2e-" });
      const supabaseDir = path.join(workdir, "supabase");
      const tempDir = path.join(supabaseDir, ".temp");
      yield* fs.makeDirectory(tempDir, { recursive: true });
      yield* fs.writeFileString(path.join(supabaseDir, "config.toml"), 'project_id = "demo"\n');
      yield* fs.writeFileString(path.join(tempDir, "cli-latest"), "v99.99.99");
      yield* program(workdir);
    }),
  );

const runWithServices = <A, E>(program: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(program.pipe(Effect.provide(BunServices.layer)));

/**
 * CLI-1906: the real bug here is the actual OS process exit code —
 * `ProcessControl.exit` calls real `process.exit(code)`, so only a genuine
 * subprocess run proves the shipped binary's exit code changed. Everything
 * else about this fix (`exitCodeForFailure`'s classification) is covered by
 * `run.unit.test.ts` and `run.integration.test.ts`; this is the one minimal
 * case that observes the real subprocess boundary.
 */
describe("legacy CLI process exit codes (CLI-1906)", () => {
  test("bare `branches` (no subcommand, no --help) exits 0", () =>
    runWithServices(
      Effect.gen(function* () {
        const { exitCode } = yield* run(["branches"], { entrypoint: "legacy" });
        expect(exitCode).toBe(0);
      }),
    ));

  test("a genuine parse error still exits 1", () =>
    runWithServices(
      Effect.gen(function* () {
        const { exitCode } = yield* run(["branches", "--this-flag-does-not-exist"], {
          entrypoint: "legacy",
        });
        expect(exitCode).toBe(1);
      }),
    ));
});

/**
 * CLI-1901: a required-flag/choice parse failure used to dump the full help
 * doc to **stdout** and print the error **twice** on stderr. The buffering
 * mechanism that fixes this (`withoutParseErrorHelpDump` in `run.ts`) is
 * already covered against a real command definition, in-process, by
 * `run.integration.test.ts` — this is the one minimal case that observes the
 * real subprocess boundary: whether the actual `stdout`/`stderr` streams of
 * the shipped binary stay separated, and whether the error text is
 * de-duplicated, matching the real `apps/cli-go/supabase-go` binary (Go
 * still shows a usage block for an unrecognized flag — raised during
 * `ParseFlags`, before `PersistentPreRunE` sets `SilenceUsage`
 * (`apps/cli-go/cmd/root.go:97`) — always on stderr, never stdout;
 * verified directly against the built Go binary).
 */
describe("legacy CLI required-flag/choice parse errors (CLI-1901)", () => {
  test("an unrecognized flag: stdout stays clean, the help/usage content and the single error line land on stderr with no duplicate", () =>
    runWithServices(
      Effect.gen(function* () {
        const { exitCode, stdout, stderr } = yield* run(
          ["branches", "--this-flag-does-not-exist"],
          { entrypoint: "legacy" },
        );
        expect(exitCode).toBe(1);
        expect(stdout).toBe("");
        // Matches Go's still-shown usage block for this error class (see the
        // describe-level comment) — this library's help doc isn't byte-identical
        // to cobra's shorter usage template, but it's on the right stream now.
        expect(stderr).toContain("USAGE");
        // The error text appears exactly once — before the fix, the library's own
        // duplicate render put it on stderr a second time (on top of the stdout
        // help dump this test doesn't even need to check for, since stdout is
        // asserted empty above).
        const occurrences =
          stderr.split("Unrecognized flag: --this-flag-does-not-exist").length - 1;
        expect(occurrences).toBe(1);
        expect(
          stderr
            .trim()
            .endsWith("Try rerunning the command with --debug to troubleshoot the error."),
        ).toBe(true);
      }),
    ));
});

/** Real-subprocess proof of the `afterSuccess` wiring; everything else lives in `legacy-upgrade-notice.unit.test.ts`. */
describe("legacy CLI upgrade notice (#5853)", () => {
  test("prints the cached notice on success and honors SUPABASE_NO_UPDATE_NOTIFIER", () =>
    runWithServices(
      withUpgradeFixture((workdir) =>
        Effect.gen(function* () {
          const enabled = yield* run(["branches"], {
            entrypoint: "legacy",
            cwd: workdir,
            env: { SUPABASE_NO_UPDATE_NOTIFIER: "0" },
          });
          expect(enabled.exitCode).toBe(0);
          expect(enabled.stderr).toContain("A new version of Supabase CLI is available: v99.99.99");

          const suppressed = yield* run(["branches"], { entrypoint: "legacy", cwd: workdir });
          expect(suppressed.exitCode).toBe(0);
          expect(suppressed.stderr).not.toContain("A new version of Supabase CLI is available");

          const helped = yield* run(["branches", "--help"], {
            entrypoint: "legacy",
            cwd: workdir,
            env: { SUPABASE_NO_UPDATE_NOTIFIER: "0" },
          });
          expect(helped.exitCode).toBe(0);
          expect(helped.stderr).toContain("A new version of Supabase CLI is available: v99.99.99");
        }),
      ),
    ));

  test("a failing command exits non-zero and prints no notice", () =>
    runWithServices(
      withUpgradeFixture((workdir) =>
        Effect.gen(function* () {
          const { exitCode, stderr } = yield* run(["branches", "--nope"], {
            entrypoint: "legacy",
            cwd: workdir,
            env: { SUPABASE_NO_UPDATE_NOTIFIER: "0" },
          });
          expect(exitCode).toBe(1);
          expect(stderr).not.toContain("A new version of Supabase CLI is available");
        }),
      ),
    ));

  test("keeps the Go upgrade notice before a native command suggestion", () =>
    runWithServices(
      withUpgradeFixture((workdir) =>
        Effect.gen(function* () {
          const enabled = yield* run(["gen", "signing-key"], {
            entrypoint: "legacy",
            cwd: workdir,
            env: { SUPABASE_NO_UPDATE_NOTIFIER: "0" },
          });
          expect(enabled.exitCode).toBe(0);
          const noticeIndex = enabled.stderr.indexOf("A new version of Supabase CLI is available");
          const suggestionIndex = enabled.stderr.indexOf(
            "To enable JWT signing keys in your local project:",
          );
          expect(noticeIndex).toBeGreaterThanOrEqual(0);
          expect(suggestionIndex).toBeGreaterThan(noticeIndex);

          const suppressed = yield* run(["gen", "signing-key"], {
            entrypoint: "legacy",
            cwd: workdir,
          });
          expect(suppressed.exitCode).toBe(0);
          expect(suppressed.stderr).not.toContain("A new version of Supabase CLI is available");
          expect(suppressed.stderr).toContain("To enable JWT signing keys in your local project:");
        }),
      ),
    ));
});
