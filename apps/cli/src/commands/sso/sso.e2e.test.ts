import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { runSupabaseEffect } from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const TEST_PROJECT_REF = "abcdefghijklmnopqrst";
const TEST_TOKEN = "sbp_" + "a".repeat(40);

describe("supabase sso", () => {
  it.live(
    "info --output-format=json emits derived URLs (no auth needed)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "sso-e2e-" });
        const { exitCode, stdout } = yield* runSupabaseEffect(
          ["sso", "info", "--project-ref", TEST_PROJECT_REF, "--output-format", "json"],
          { cwd, env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
        );
        expect(exitCode).toBe(0);
        expect(stdout).toContain(`https://${TEST_PROJECT_REF}.supabase.co/auth/v1/sso/saml/acs`);
        expect(stdout).toContain(
          `https://${TEST_PROJECT_REF}.supabase.co/auth/v1/sso/saml/metadata`,
        );
        expect(stdout).toContain(`https://${TEST_PROJECT_REF}.supabase.co`);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    { timeout: E2E_TIMEOUT_MS },
  );

  it.live(
    "info text mode prints all three URLs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "sso-e2e-" });
        const { exitCode, stdout } = yield* runSupabaseEffect(
          ["sso", "info", "--project-ref", TEST_PROJECT_REF],
          { cwd, env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
        );
        expect(exitCode).toBe(0);
        expect(stdout).toContain(`https://${TEST_PROJECT_REF}.supabase.co/auth/v1/sso/saml/acs`);
        expect(stdout).toContain(
          `https://${TEST_PROJECT_REF}.supabase.co/auth/v1/sso/saml/metadata`,
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    { timeout: E2E_TIMEOUT_MS },
  );

  it.live(
    "show with invalid UUID exits 1 with Go-format message",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "sso-e2e-" });
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["sso", "show", "not-a-uuid", "--project-ref", TEST_PROJECT_REF],
          { cwd, env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
        );
        expect(exitCode).toBe(1);
        expect(`${stdout}${stderr}`).toContain(`identity provider ID "not-a-uuid" is not a UUID`);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    { timeout: E2E_TIMEOUT_MS },
  );

  it.live(
    "remove with invalid UUID exits 1 with Go-format message",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "sso-e2e-" });
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["sso", "remove", "not-a-uuid", "--project-ref", TEST_PROJECT_REF],
          { cwd, env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
        );
        expect(exitCode).toBe(1);
        expect(`${stdout}${stderr}`).toContain(`identity provider ID "not-a-uuid" is not a UUID`);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    { timeout: E2E_TIMEOUT_MS },
  );

  it.live(
    "update with invalid UUID exits 1 with Go-format message",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "sso-e2e-" });
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["sso", "update", "not-a-uuid", "--project-ref", TEST_PROJECT_REF],
          { cwd, env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
        );
        expect(exitCode).toBe(1);
        expect(`${stdout}${stderr}`).toContain(`identity provider ID "not-a-uuid" is not a UUID`);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    { timeout: E2E_TIMEOUT_MS },
  );

  // Usage-silencing is set before required-flag validation, so a missing
  // `--type` prints a single clean stderr line with no usage block — but
  // `Flag.choice` validation runs during parsing, before that point, so an
  // invalid `--type` value still shows a usage block.
  it.live(
    "add without --type: stdout stays clean, stderr is a single Go-parity line (no usage block)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "sso-e2e-" });
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["sso", "add", "--project-ref", TEST_PROJECT_REF],
          { cwd },
        );
        expect(exitCode).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain(`required flag(s) "type" not set`);
        expect(stderr).not.toContain("USAGE");
        expect(stderr.trim().split("\n")).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    { timeout: E2E_TIMEOUT_MS },
  );

  it.live(
    "add with an invalid --type value: stdout stays clean, the usage content and the single error line land on stderr with no duplicate",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "sso-e2e-" });
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["sso", "add", "--type", "bogus", "--project-ref", TEST_PROJECT_REF],
          { cwd },
        );
        expect(exitCode).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("USAGE");
        const occurrences = stderr.split(`Invalid value for flag --type: "bogus"`).length - 1;
        expect(occurrences).toBe(1);
        expect(
          stderr
            .trim()
            .endsWith("Try rerunning the command with --debug to troubleshoot the error."),
        ).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    { timeout: E2E_TIMEOUT_MS },
  );
});
