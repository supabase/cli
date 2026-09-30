import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect, withTempHome } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

// A closed local port: no config.toml or running stack needed, and the connection fails fast
// without depending on a live database in CI.
const DEAD_DB_URL = "postgres://postgres:postgres@127.0.0.1:1/postgres";

// `--agent no` forces text-mode output deterministically (the CLI otherwise
// auto-selects JSON on stdout in a detected agent environment).
const TEXT_MODE = ["--agent", "no"];

describe("supabase inspect report", () => {
  it.live(
    "creates the dated output directory and prints the connect diagnostic before failing on an unreachable database",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const outputDir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-report-e2e-" });
          const { exitCode, stderr } = yield* runSupabaseEffect(
            ["inspect", "report", ...TEXT_MODE, "--db-url", DEAD_DB_URL, "--output-dir", outputDir],
            { home: home.dir, env: { HOME: home.dir } },
          );
          expect(exitCode).toBe(1);
          expect(stderr).toContain("Connecting to remote database...");
          expect(stderr).toMatch(/failed to connect to postgres|connection refused|ECONNREFUSED/i);
          const dated = (yield* fs.readDirectory(outputDir)).filter((name) =>
            /^\d{4}-\d{2}-\d{2}$/.test(name),
          );
          expect(dated.length).toBe(1);
          expect(yield* fs.exists(path.join(outputDir, dated[0]!))).toBe(true);
        }),
      ).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
});
