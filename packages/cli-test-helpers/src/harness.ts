import { tmpdir, platform as osPlatform } from "node:os";
import { randomUUID } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";

const runBunSync = <A, E extends Error>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): A => Effect.runSync(effect.pipe(Effect.orDie, Effect.provide(BunServices.layer)));

const runBunPromise = <A, E extends Error>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.orDie, Effect.provide(BunServices.layer)));

const join = (...parts: ReadonlyArray<string>): string =>
  runBunSync(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return path.join(...parts);
    }),
  );

const exists = (path: string): Effect.Effect<boolean, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(path);
  });

const mkdtemp = (prefix: string): Effect.Effect<string, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectory({ directory: tmpdir(), prefix });
  });

const rm = (
  path: string,
  options?: { readonly recursive?: boolean; readonly force?: boolean },
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(path, {
      recursive: options?.recursive ?? false,
      force: options?.force ?? false,
    });
  });

export type CLITarget = "ts-legacy" | "ts-next";

export interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface HarnessOptions {
  /** Replay server base URL, set as SUPABASE_API_URL in the subprocess */
  apiUrl: string;
  /** Access token injected as SUPABASE_ACCESS_TOKEN */
  accessToken: string;
  /** Monorepo root containing apps/cli/dist. Defaults to this workspace root. */
  workspaceRoot?: string;
  /** Working directory for the subprocess. Defaults to a fresh temp dir. */
  cwd?: string;
  /** Set as SUPABASE_PROJECT_ID in the subprocess env. Storage commands read
   *  this via viper (no --project-ref flag) for config validation in --local mode. */
  projectId?: string;
  /** Profile `project_host` — the domain the CLI derives per-project hosts from
   *  (storage `<ref>.<host>`, db `db.<ref>.<host>`, etc.). Defaults to "localhost"
   *  for replay/mock runs; live mode sets the real target host (e.g. supabase.red)
   *  so host-derived commands like `storage --linked` reach the real endpoint. */
  projectHost?: string;
}

export interface CLIHarness {
  readonly target: CLITarget;
  readonly options: HarnessOptions;
}

/** A temporary directory that is removed when disposed. */
export interface TempDir {
  readonly path: string;
  [Symbol.asyncDispose](): Promise<void>;
}

class MissingCliBuildError extends Data.TaggedError("MissingCliBuildError")<{
  readonly shimPath: string;
  readonly binaryPath: string;
  readonly message: string;
}> {
  constructor(shimPath: string, binaryPath: string) {
    super({
      shimPath,
      binaryPath,
      message:
        `Missing CLI build artifacts. Run \`pnpm --filter supabase build\` before running e2e tests.\n` +
        `  expected shim:   ${shimPath}\n` +
        `  expected binary: ${binaryPath}`,
    });
  }
}

/** Create a unique temporary directory under os.tmpdir() for use as a CLI
 *  working directory. Dispose it after the test to clean up. */
export function makeTempDir(prefix = "cli-e2e-"): Promise<TempDir> {
  return runBunPromise(
    Effect.gen(function* () {
      const path = yield* mkdtemp(prefix);
      return {
        path,
        [Symbol.asyncDispose]: () => runBunPromise(rm(path, { recursive: true, force: true })),
      } satisfies TempDir;
    }),
  );
}

// Resolve the monorepo root from this file's location:
// packages/cli-test-helpers/src/harness.ts -> ../../../ = repo root
const WORKSPACE_ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

const BINARY_EXT = osPlatform() === "win32" ? ".exe" : "";

// E2E subprocesses should only enter agent output mode when a test explicitly
// opts in via `opts.env`. Keep this list aligned with @vercel/detect-agent env
// probes so a developer's shell cannot accidentally change CLI rendering.
const AGENT_DETECTION_ENV_KEYS: readonly string[] = [
  "AI_AGENT",
  "CURSOR_TRACE_ID",
  "CURSOR_AGENT",
  "CURSOR_EXTENSION_HOST_ROLE",
  "GEMINI_CLI",
  "CODEX_SANDBOX",
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "ANTIGRAVITY_AGENT",
  "AUGMENT_AGENT",
  "OPENCODE_CLIENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_IS_COWORK",
  "REPL_ID",
  "COPILOT_MODEL",
  "COPILOT_ALLOW_ALL",
  "COPILOT_GITHUB_TOKEN",
];

export function createSubprocessBaseEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of AGENT_DETECTION_ENV_KEYS) delete env[key];
  return env;
}

function tsCliShim(workspaceRoot: string): string {
  return join(workspaceRoot, "apps/cli/dist/supabase.js");
}

function tsCliBinary(workspaceRoot: string, shell: "next" | "legacy"): string {
  return join(workspaceRoot, `apps/cli/dist/supabase-${shell}${BINARY_EXT}`);
}

const assertTsCliBuilt = (shimPath: string, binaryPath: string) =>
  Effect.gen(function* () {
    const shimExists = yield* exists(shimPath);
    const binaryExists = yield* exists(binaryPath);
    if (!shimExists || !binaryExists) {
      return yield* new MissingCliBuildError(shimPath, binaryPath);
    }
  });

interface BuiltCommand {
  cmd: string[];
  binaryOverride?: string;
}

const buildCommand = (target: CLITarget, workspaceRoot: string) =>
  Effect.gen(function* () {
    const shell = target === "ts-legacy" ? "legacy" : "next";
    const shimPath = tsCliShim(workspaceRoot);
    const binaryPath = tsCliBinary(workspaceRoot, shell);
    yield* assertTsCliBuilt(shimPath, binaryPath);
    return { cmd: ["node", shimPath], binaryOverride: binaryPath } satisfies BuiltCommand;
  });

export function createHarness(target: CLITarget, options: HarnessOptions): CLIHarness {
  return { target, options };
}

// oxlint-disable-next-line effecttsgo/async-function -- Promise facade intentionally consumed by non-Effect e2e tests.
export async function exec(
  harness: CLIHarness,
  args: string[],
  opts?: { env?: Record<string, string> },
): Promise<CLIResult> {
  const start = performance.now();
  const built = await runBunPromise(
    buildCommand(harness.target, harness.options.workspaceRoot ?? WORKSPACE_ROOT),
  );

  const env: Record<string, string> = {
    ...createSubprocessBaseEnv(),
    SUPABASE_ACCESS_TOKEN: harness.options.accessToken,
    SUPABASE_NO_KEYRING: "true",
    SUPABASE_TELEMETRY_DISABLED: "1",
    // Isolate CLI filesystem side-effects (e.g. telemetry.json) to the CWD so
    // tests don't touch the developer's real ~/.supabase.
    SUPABASE_HOME: harness.options.cwd ?? tmpdir(),
    ...(harness.options.projectId ? { SUPABASE_PROJECT_ID: harness.options.projectId } : {}),
    // When a test writes a pooler-url file the Go CLI takes the pooler path in
    // ParseDatabaseConfig. Setting a non-empty password avoids the initPoolerLogin
    // API call so the only network traffic is the actual Management API call
    // under test. Safe to set globally: it is only used when pooler-url exists.
    SUPABASE_DB_PASSWORD: "test-placeholder-password",
    ...(built.binaryOverride ? { SUPABASE_CLI_BINARY_OVERRIDE: built.binaryOverride } : {}),
    ...opts?.env,
  };

  // The Go CLI uses a profile system rather than SUPABASE_API_URL. The ts-legacy
  // CLI mirrors this dual semantics in `LegacyCliConfig` (built-in name first,
  // YAML file path second) for any natively-ported command; proxy-wrapped
  // commands still shell out to Go, which reads the same file directly via
  // viper's SUPABASE_PROFILE (prefix SUPABASE_ + AutomaticEnv) when the value
  // isn't a built-in profile name. Write a temporary profile file pointing at
  // the replay server so both paths reach it.
  // - ts-next reads SUPABASE_API_URL directly, so it doesn't need a profile file.
  let profilePath: string | undefined;
  if (harness.target === "ts-legacy") {
    const nextProfilePath = join(tmpdir(), `cli-e2e-profile-${randomUUID()}.yaml`);
    profilePath = nextProfilePath;
    const url = harness.options.apiUrl;
    await runBunPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          nextProfilePath,
          [
            `name: test`,
            `api_url: "${url}"`,
            `dashboard_url: "${url}"`,
            `project_host: ${harness.options.projectHost ?? "localhost"}`,
          ].join("\n"),
        );
      }),
    );
    env["SUPABASE_PROFILE"] = profilePath;
  } else {
    env["SUPABASE_API_URL"] = harness.options.apiUrl;
  }

  const proc = Bun.spawn([...built.cmd, ...args], {
    env,
    // Default to os.tmpdir() so subprocess file writes never land in the repo
    cwd: harness.options.cwd ?? tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  const durationMs = performance.now() - start;

  if (profilePath) await runBunPromise(rm(profilePath, { force: true }));

  return { stdout, stderr, exitCode, durationMs };
}
