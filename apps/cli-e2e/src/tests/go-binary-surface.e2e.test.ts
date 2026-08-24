import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { readEnv } from "./env.ts";

// CLI-1970 shrank the bundled `supabase-go` binary down to exactly the
// commands the TypeScript CLI's `LegacyGoProxy` can spawn — every other Go
// command was deleted outright. Every TS integration test stubs that
// subprocess boundary, so nothing in the normal test pyramid notices when a
// still-reachable Go command gets trimmed away by mistake: that regression
// was previously caught only by a human audit.
//
// This suite is the durable guard: it enumerates every argv shape the TS
// side can hand to `LegacyGoProxy` and asserts the built `supabase-go`
// binary still resolves it. If this fails after trimming the Go binary,
// either the TS spawn surface grew (add the new command to the retained
// set in `apps/cli-go`) or the trim cut too deep (restore the command).
//
// `SUPABASE_GO_BINARY` is only set to a freshly built binary in CI (see
// `.github/workflows/test.yml`); locally this whole suite no-ops so a
// developer without a Go toolchain/build isn't forced to fail it.
const GO_BINARY = readEnv("SUPABASE_GO_BINARY");
const testLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

describe.skipIf(GO_BINARY === undefined)("go binary spawn surface (CLI-1970)", () => {
  const binary = GO_BINARY as string;

  let workspaceDir: string;
  let bogusProfilePath: string;

  beforeAll(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        workspaceDir = yield* fs.makeTempDirectory({ prefix: "cli-e2e-go-binary-surface-" });

        // `cmd/root.go`'s `checkUpgrade` hits the real GitHub releases API on
        // every invocation that returns a nil error (e.g. every `--help` call
        // below), unless a `supabase/.temp/cli-latest` cache file already exists
        // relative to the spawn's cwd and is less than 10h old (`shouldFetchRelease`).
        // Pre-seeding it here keeps this whole suite hermetic instead of quietly
        // depending on network access.
        yield* fs.makeDirectory(path.join(workspaceDir, "supabase", ".temp"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workspaceDir, "supabase", ".temp", "cli-latest"),
          "v0.0.0",
        );

        // A bogus `--profile` for the two Management-API-gated delegates (`gen
        // keys`, `functions download --legacy-bundle`). The unique profile name
        // guarantees an OS-keyring credential from a real `supabase login` can
        // never match it, and the unreachable api_url means even a stray token
        // match still fails at connect instead of reaching a real API.
        bogusProfilePath = path.join(workspaceDir, "profile.yaml");
        yield* fs.writeFileString(
          bogusProfilePath,
          [
            "name: cli-e2e-go-binary-surface-guard",
            'api_url: "http://127.0.0.1:1"',
            'dashboard_url: "http://127.0.0.1:1"',
            "project_host: localhost",
          ].join("\n"),
        );
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  afterAll(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(workspaceDir, { recursive: true });
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  function runGo(args: ReadonlyArray<string>, envOverrides: Record<string, string> = {}) {
    const result = Bun.spawnSync([binary, ...args], {
      cwd: workspaceDir,
      env: {
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

  // The complete spawn surface, mirrored from `LegacyGoProxy` call sites:
  //   - db diff (diff.handler.ts, `--use-pg-schema` delegate path)
  //   - db pull (pull.handler.ts, `--experimental` delegate path)
  //   - db branch create|delete|list|switch (thin proxies)
  //   - db remote changes|commit (thin proxies)
  //   - gen keys (keys.handler.ts)
  //   - functions download (shared/functions/download.ts, `--legacy-bundle`)
  const RETAINED_COMMAND_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
    ["db", "diff"],
    ["db", "pull"],
    ["db", "branch", "create"],
    ["db", "branch", "delete"],
    ["db", "branch", "list"],
    ["db", "branch", "switch"],
    ["db", "remote", "changes"],
    ["db", "remote", "commit"],
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
        // A deleted NESTED subcommand (as opposed to a deleted top-level
        // one) does not produce an "unknown command" error at all: cobra's
        // default Args validator only rejects unmatched positional args on
        // the root command, so `db diff --help` with `diff` deleted would
        // otherwise silently fall through to printing `db`'s own help and
        // exit 0 — verified empirically by deleting a command and watching
        // this exact assertion catch it. Asserting the full resolved
        // command path appears in the printed usage closes that gap: cobra
        // renders `Usage:\n  supabase <path> [flags]` using each ancestor's
        // Name() (the Use string's first token), so this substring is only
        // present when the whole path actually resolved.
        expect(output).toContain(`supabase ${path.join(" ")}`);
      }, 5_000);
    }
  });

  describe("accepts the exact argv shape the TS proxy builds", () => {
    // `db diff --use-pg-schema` (diff.handler.ts's `rebuildPgSchemaDelegateArgs`).
    // `db diff` always provisions a Docker shadow database first, regardless
    // of the differ engine, so the bogus DOCKER_HOST is what makes this fail
    // fast rather than the bogus --db-url.
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

    // `db pull --experimental` (pull.handler.ts's `rebuildDelegateArgs`), with
    // the complete global-flag set root.ts can prepend (globalArgs) — the
    // only invocation in this suite exercising all ten at once. `db pull`
    // connects directly to --db-url before touching Docker, so this fails at
    // connect regardless of the (unused here) --network-id/--profile values.
    test("db pull --experimental (full global flag set)", () => {
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
        "pull",
        "--experimental",
        "--db-url",
        "postgresql://u:p@127.0.0.1:1/x",
        "--schema",
        "public",
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).not.toMatch(/unknown flag|invalid argument/i);
    }, 5_000);

    // `db remote changes` (changes.handler.ts). Also provisions a Docker
    // shadow first (same as `db diff`), so the bogus DOCKER_HOST is what
    // trips this one too.
    test("db remote changes", () => {
      const { exitCode, stderr } = runGo([
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

    // `db remote commit` (commit.handler.ts). Connects directly to --db-url
    // before touching Docker (same as `db pull`).
    test("db remote commit", () => {
      const { exitCode, stderr } = runGo([
        "db",
        "remote",
        "commit",
        "--db-url",
        "postgresql://u:p@127.0.0.1:1/x",
        "--schema",
        "public",
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).not.toMatch(/unknown flag|invalid argument/i);
    }, 5_000);

    // `gen keys` (keys.handler.ts). Gated behind Go's Management-API login
    // check before any network call, so an isolated SUPABASE_HOME (no stored
    // credentials) plus the bogus --profile fails fast without ever reaching
    // a real API — regardless of whatever is logged into on this machine.
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

    // `functions download --legacy-bundle` (shared/functions/download.ts's
    // `makeGoProxyLegacyBundleArgs`). Same login-gate fail-fast as `gen keys`.
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
    // `["db", "start"]` deliberately is NOT used here even though it's a
    // deleted command: cobra's default Args validator only rejects unmatched
    // positional args on the ROOT command. A nested group like `db` silently
    // falls through to printing its own help (exit 0) for an unrecognized
    // child instead of erroring — verified empirically against the built
    // binary. Only a deleted TOP-LEVEL command reliably reproduces the
    // "unknown command" failure this guard needs to detect drift in both
    // directions.
    for (const deletedCommand of ["inspect", "start"]) {
      test(`supabase-go ${deletedCommand} reports unknown command`, () => {
        const { exitCode, stderr } = runGo([deletedCommand]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain("unknown command");
      }, 5_000);
    }
  });
});
