import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { runSupabaseEffect, withTempHome } from "../../../../tests/helpers/cli.ts";

// These flag-validation checks are native TS and fail before any network
// call, so no auth or linked project is required. Kept as e2e, not
// integration, to assert the exact error text through the real CLI
// entrypoint rather than risk a false pass from an unrelated non-zero exit.

const E2E_TIMEOUT_MS = 30_000;
const SLUG = "deploy-e2e-basic";
// Valid-format token + ref clear the auth and project-ref gates but are never
// used against a real API, since these cases fail before any network call.
const FAKE_TOKEN = `sbp_${"0".repeat(40)}`;
const FAKE_REF = "a".repeat(20);

describe("supabase functions deploy — argument validation", () => {
  const conflicts = [
    { name: "--use-api + --use-docker", flags: ["--use-api", "--use-docker"] },
    { name: "--use-api + --legacy-bundle", flags: ["--use-api", "--legacy-bundle"] },
    { name: "--use-docker + --legacy-bundle", flags: ["--use-docker", "--legacy-bundle"] },
  ] as const;

  for (const { name, flags } of conflicts) {
    it.live(
      `rejects ${name} as mutually exclusive`,
      () =>
        withTempHome((home) =>
          Effect.gen(function* () {
            const { exitCode, stderr } = yield* runSupabaseEffect(
              ["functions", "deploy", SLUG, "--project-ref", FAKE_REF, ...flags],
              {
                home: home.dir,
                env: { HOME: home.dir, SUPABASE_ACCESS_TOKEN: FAKE_TOKEN },
              },
            );
            expect(exitCode).not.toBe(0);
            expect(stderr).toContain(
              "if any flags in the group [use-api use-docker legacy-bundle] are set none of the others can be",
            );
          }),
        ),
      E2E_TIMEOUT_MS,
    );
  }

  it.live(
    "rejects --jobs without --use-api",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const { exitCode, stderr } = yield* runSupabaseEffect(
            ["functions", "deploy", SLUG, "--project-ref", FAKE_REF, "--use-docker", "--jobs", "2"],
            {
              home: home.dir,
              env: { HOME: home.dir, SUPABASE_ACCESS_TOKEN: FAKE_TOKEN },
            },
          );
          expect(exitCode).not.toBe(0);
          expect(stderr).toContain("--jobs must be used together with --use-api");
        }),
      ),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "rejects --jobs without --use-api even with --use-docker=false (Go parity gap)",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const { exitCode, stderr } = yield* runSupabaseEffect(
            [
              "functions",
              "deploy",
              SLUG,
              "--project-ref",
              FAKE_REF,
              "--use-docker=false",
              "--jobs",
              "2",
            ],
            {
              home: home.dir,
              env: { HOME: home.dir, SUPABASE_ACCESS_TOKEN: FAKE_TOKEN },
            },
          );
          expect(exitCode).not.toBe(0);
          expect(stderr).toContain("--jobs must be used together with --use-api");
        }),
      ),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "fails without a linked project or --project-ref",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "fn-deploy-nolink-" });
          const { exitCode, stderr } = yield* runSupabaseEffect(["functions", "deploy", SLUG], {
            home: home.dir,
            cwd: workdir,
            env: { HOME: home.dir, SUPABASE_ACCESS_TOKEN: FAKE_TOKEN },
          });
          expect(exitCode).not.toBe(0);
          expect(stderr).toMatch(/Cannot find project ref|Have you run|supabase link/i);
        }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
      ),
    E2E_TIMEOUT_MS,
  );
});
