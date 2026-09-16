import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// The bundled `supabase-go` binary retains only the commands the TypeScript
// CLI's `GoProxy` can spawn; every other Go command was deleted. TS
// integration tests stub that subprocess boundary, so nothing else notices if
// a still-reachable Go command gets trimmed away by mistake.
//
// This suite enumerates every argv shape the TS side can hand to `GoProxy`
// and asserts the built `supabase-go` binary still resolves it. If this
// fails, either the TS spawn surface grew (add the command to the retained
// set in `apps/cli-go`) or the trim cut too deep (restore the command).
//
// `SUPABASE_GO_BINARY` is only set to a freshly built binary in CI (see
// `.github/workflows/test.yml`); locally this whole suite no-ops.
const GO_BINARY = process.env["SUPABASE_GO_BINARY"];

describe.skipIf(GO_BINARY === undefined)("go binary spawn surface (CLI-1970)", () => {
  const binary = GO_BINARY as string;

  let workspaceDir: string;
  let bogusProfilePath: string;

  beforeAll(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "cli-e2e-go-binary-surface-"));

    // The upgrade check hits the real GitHub releases API on every invocation
    // that returns a nil error (e.g. every `--help` call below), unless a
    // `supabase/.temp/cli-latest` cache file already exists and is less than
    // 10h old. Pre-seeding it here keeps this suite hermetic.
    mkdirSync(join(workspaceDir, "supabase", ".temp"), { recursive: true });
    writeFileSync(join(workspaceDir, "supabase", ".temp", "cli-latest"), "v0.0.0");

    // A bogus `--profile` for the two Management-API-gated delegates (`gen
    // keys`, `functions download --legacy-bundle`): the unique profile name
    // can never match a real stored credential, and the unreachable api_url
    // means even a stray match still fails at connect.
    bogusProfilePath = join(workspaceDir, "profile.yaml");
    writeFileSync(
      bogusProfilePath,
      [
        "name: cli-e2e-go-binary-surface-guard",
        'api_url: "http://127.0.0.1:1"',
        'dashboard_url: "http://127.0.0.1:1"',
        "project_host: localhost",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function runGo(args: ReadonlyArray<string>, envOverrides: Record<string, string> = {}) {
    const result = Bun.spawnSync([binary, ...args], {
      cwd: workspaceDir,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: workspaceDir,
        SUPABASE_HOME: workspaceDir,
        // Belt-and-braces: no command exercised here should ever reach a
        // real Docker daemon or send real telemetry.
        DOCKER_HOST: "tcp://127.0.0.1:1",
        SUPABASE_TELEMETRY_DISABLED: "1",
        ...envOverrides,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  // The complete spawn surface, mirrored from `GoProxy` call sites:
  //   - db diff (diff.handler.ts, `--use-pg-schema` delegate path)
  //   - db branch create|delete|list|switch (thin proxies)
  //   - db remote changes (thin proxy)
  //   - gen keys (keys.handler.ts)
  //   - functions download (shared/functions/download.ts, `--legacy-bundle`)
  const RETAINED_COMMAND_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
    ["db", "diff"],
    ["db", "branch", "create"],
    ["db", "branch", "delete"],
    ["db", "branch", "list"],
    ["db", "branch", "switch"],
    ["db", "remote", "changes"],
    ["gen", "keys"],
    ["functions", "download"],
  ];

  describe("resolves every retained command path", () => {
    for (const path of RETAINED_COMMAND_PATHS) {
      test(`supabase-go ${path.join(" ")} --help exits 0`, () => {
        const { exitCode, stdout, stderr } = runGo([...path, "--help"]);
        const output = stdout + stderr;
        expect(exitCode).toBe(0);
        expect(output).not.toContain("unknown command");
        // A deleted nested subcommand doesn't error "unknown command": cobra
        // only rejects unmatched args on the root command, so `db diff --help`
        // with `diff` deleted would fall through to `db`'s own help (exit 0).
        // Asserting the full command path appears in the usage output closes
        // that gap — cobra only prints it once the whole path has resolved.
        expect(output).toContain(`supabase ${path.join(" ")}`);
      }, 5_000);
    }
  });

  describe("accepts the exact argv shape the TS proxy builds", () => {
    // `db diff` always provisions a Docker shadow database first, so the bogus
    // DOCKER_HOST is what makes this fail fast, not the bogus --db-url.
    test("db diff --use-pg-schema", () => {
      const { exitCode, stderr } = runGo([
        "db",
        "diff",
        "--use-pg-schema",
        "--db-url",
        "postgresql://u:p@127.0.0.1:1/x",
        "--schema",
        "public",
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).not.toMatch(/unknown flag|invalid argument/i);
    }, 5_000);

    // The only invocation in this suite exercising the full global-flag set at
    // once. Also provisions a Docker shadow first, so DOCKER_HOST trips it.
    test("db remote changes (full global flag set)", () => {
      const { exitCode, stderr } = runGo([
        "--output",
        "json",
        "--profile",
        "supabase-staging",
        "--debug",
        "--workdir",
        workspaceDir,
        "--experimental",
        "--network-id",
        "cli-e2e-test-net",
        "--yes",
        "--dns-resolver",
        "https",
        "--create-ticket",
        "--agent",
        "no",
        "db",
        "remote",
        "changes",
        "--db-url",
        "postgresql://u:p@127.0.0.1:1/x",
        "--schema",
        "public",
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).not.toMatch(/unknown flag|invalid argument/i);
    }, 5_000);

    // Gated behind a login check before any network call, so an isolated
    // SUPABASE_HOME plus the bogus --profile fails fast without reaching a real API.
    test("gen keys", () => {
      const { exitCode, stderr } = runGo([
        "gen",
        "keys",
        "--project-ref",
        "abcdefghijklmnopqrst",
        "--override-name",
        "db.host=CUSTOM_DB_HOST",
        "--experimental",
        "--profile",
        bogusProfilePath,
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).not.toMatch(/unknown flag|invalid argument/i);
    }, 5_000);

    // Same login-gate fail-fast as `gen keys`.
    test("functions download --legacy-bundle", () => {
      const { exitCode, stderr } = runGo([
        "functions",
        "download",
        "my-function",
        "--project-ref",
        "abcdefghijklmnopqrst",
        "--legacy-bundle",
        "--profile",
        bogusProfilePath,
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).not.toMatch(/unknown flag|invalid argument/i);
    }, 5_000);
  });

  describe("negative control: a deleted command still reports unknown", () => {
    // `["db", "start"]` isn't used here even though it's a deleted command:
    // like the nested-subcommand case above, `db` would fall through to its
    // own help (exit 0) instead of erroring. Only a deleted top-level command
    // reliably reproduces "unknown command".
    for (const deletedCommand of ["inspect", "start"]) {
      test(`supabase-go ${deletedCommand} reports unknown command`, () => {
        const { exitCode, stderr } = runGo([deletedCommand]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("unknown command");
      }, 5_000);
    }
  });
});
