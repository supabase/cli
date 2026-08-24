import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { describe, expect, test } from "vitest";

import { makeTempHome, runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

// A definitely-closed local port: the `--db-url` is parsed directly (no config.toml
// / running stack needed), so the native handler creates the dated output directory,
// prints the connect diagnostic, then fails fast dialing. This exercises the real
// subprocess path — flag parse → resolution → mkdir → native connect — without
// depending on a live database in CI.
const DEAD_DB_URL = "postgres://postgres:postgres@127.0.0.1:1/postgres";

// `--agent no` forces text-mode output deterministically (the CLI otherwise
// auto-selects JSON on stdout in a detected agent environment).
const TEXT_MODE = ["--agent", "no"];

const makeOutputDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectory({ prefix: "supabase-report-e2e-" });
  return { dir, cleanup: fs.remove(dir, { recursive: true }).pipe(Effect.ignore) };
}).pipe(Effect.provide(BunServices.layer));

const readReportDirectory = (outputDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dated = (yield* fs.readDirectory(outputDir)).filter((name) =>
      /^\d{4}-\d{2}-\d{2}$/u.test(name),
    );
    const exists =
      dated[0] === undefined ? false : yield* fs.exists(path.join(outputDir, dated[0]));
    return { dated, exists };
  }).pipe(Effect.provide(BunServices.layer));

describe("supabase inspect report (legacy)", () => {
  test(
    "creates the dated output directory and prints the connect diagnostic before failing on an unreachable database",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      makeTempHome().then((home) =>
        Effect.runPromise(makeOutputDirectory).then(({ dir: outputDir, cleanup }) =>
          runSupabase(
            ["inspect", "report", ...TEXT_MODE, "--db-url", DEAD_DB_URL, "--output-dir", outputDir],
            { entrypoint: "legacy", home: home.dir, env: { HOME: home.dir } },
          )
            .then(({ exitCode, stderr }) => {
              expect(exitCode).toBe(1);
              // The native handler writes the connect diagnostic to stderr.
              expect(stderr).toContain("Connecting to remote database...");
              expect(stderr).toMatch(
                /failed to connect to postgres|connection refused|ECONNREFUSED/i,
              );
              // mkdir runs before the connection, so the dated folder exists even on failure.
              return Effect.runPromise(readReportDirectory(outputDir)).then(({ dated, exists }) => {
                expect(dated.length).toBe(1);
                expect(exists).toBe(true);
              });
            })
            .finally(() =>
              Effect.runPromise(Effect.all([cleanup, home.disposeEffect], { discard: true })),
            ),
        ),
      ),
  );
});
