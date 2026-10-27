import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { tmpdir, platform as osPlatform } from "node:os";
import { randomUUID } from "node:crypto";

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
  /** Working directory for the subprocess. Defaults to a fresh temp dir. */
  cwd?: string;
  /** Set as SUPABASE_PROJECT_ID in the subprocess env. Storage commands validate
   *  against it (no --project-ref flag) for config validation in --local mode. */
  projectId?: string;
  /** Profile `project_host` — the domain the CLI derives per-project hosts from
   *  (storage `<ref>.<host>`, db `db.<ref>.<host>`, etc.). Defaults to "localhost"
   *  for replay/mock runs; live mode sets the real target host (e.g. supabase.red)
   *  so host-derived commands like `storage --linked` reach the real endpoint. */
  projectHost?: string;
}

export interface CLIHarness {
  readonly options: HarnessOptions;
}

/** A temporary directory that is removed when disposed. */
export interface TempDir {
  readonly path: string;
  [Symbol.asyncDispose](): Promise<void>;
}

class MissingCliBuildError extends Schema.TaggedError<MissingCliBuildError>()(
  "MissingCliBuildError",
  { message: Schema.String },
) {}

class SubprocessError extends Schema.TaggedError<SubprocessError>()("SubprocessError", {
  cause: Schema.Defect(),
}) {}

/* Rejects with each failure's underlying cause when it has one, and a plain Error for the build check, instead of the tagged Effect error. */
function runHarness<A>(
  effect: Effect.Effect<
    A,
    MissingCliBuildError | SubprocessError | PlatformError,
    FileSystem.FileSystem | Path.Path
  >,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.catchTags({
        MissingCliBuildError: (error) => Effect.die(new Error(error.message)),
        SubprocessError: (error) => Effect.die(error.cause),
        PlatformError: (error) => Effect.die(error.cause ?? error),
      }),
      Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
    ),
  );
}

/** Create a unique temporary directory under os.tmpdir() for use as a CLI
 *  working directory. Dispose it after the test to clean up. */
export function makeTempDir(prefix = "cli-e2e-"): Promise<TempDir> {
  return runHarness(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { basename, dirname, join } = yield* Path.Path;
      /* Prefixes tmpdir's own name, so every prefix, empty included, maps to mkdtemp(join(tmpdir(), prefix)). */
      const path = yield* fs.makeTempDirectory({
        directory: dirname(tmpdir()),
        prefix: join(basename(tmpdir()), prefix),
      });
      return {
        path,
        [Symbol.asyncDispose]() {
          return runHarness(fs.remove(path, { recursive: true, force: true }));
        },
      };
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

/* Treats any access failure, not only ENOENT, as missing. */
function exists(fs: FileSystem.FileSystem, path: string): Effect.Effect<boolean> {
  return fs.exists(path).pipe(Effect.orElseSucceed(() => false));
}

function assertTsCliBuilt(
  fs: FileSystem.FileSystem,
  shimPath: string,
  binaryPath: string,
): Effect.Effect<void, MissingCliBuildError> {
  return Effect.gen(function* () {
    if (!(yield* exists(fs, shimPath)) || !(yield* exists(fs, binaryPath))) {
      return yield* new MissingCliBuildError({
        message:
          `Missing CLI build artifacts. Run \`pnpm --filter supabase build\` before running e2e tests.\n` +
          `  expected shim:   ${shimPath}\n` +
          `  expected binary: ${binaryPath}`,
      });
    }
  });
}

interface BuiltCommand {
  cmd: string[];
  binaryOverride?: string;
}

function readText(stream: ReadableStream<Uint8Array>): Effect.Effect<string, SubprocessError> {
  return Effect.tryPromise({
    try: () => new Response(stream).text(),
    catch: (cause) => new SubprocessError({ cause }),
  });
}

export function createHarness(options: HarnessOptions): CLIHarness {
  return { options };
}

const execEffect = Effect.fnUntraced(function* (
  harness: CLIHarness,
  args: string[],
  opts?: { env?: Record<string, string> },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  /* Builds the whole invocation before the first asynchronous step, in call order, so the caller
     can mutate its inputs once exec returns. */
  const start = performance.now();
  const tsCliShim = path.join(WORKSPACE_ROOT, "apps/cli/dist/supabase.js");
  const tsCliBinary = path.join(WORKSPACE_ROOT, `apps/cli/dist/supabase${BINARY_EXT}`);
  const built: BuiltCommand = { cmd: ["node", tsCliShim], binaryOverride: tsCliBinary };

  const env: Record<string, string> = {
    ...createSubprocessBaseEnv(),
    SUPABASE_ACCESS_TOKEN: harness.options.accessToken,
    SUPABASE_NO_KEYRING: "true",
    SUPABASE_TELEMETRY_DISABLED: "1",
    // Isolate CLI filesystem side-effects (e.g. telemetry.json) to the CWD so
    // tests don't touch the developer's real ~/.supabase.
    SUPABASE_HOME: harness.options.cwd ?? tmpdir(),
    ...(harness.options.projectId ? { SUPABASE_PROJECT_ID: harness.options.projectId } : {}),
    // Setting a non-empty password avoids the interactive pooler login flow when a
    // pooler-url file is present, so the only network traffic is the Management
    // API call under test. Safe to set globally: only used when pooler-url exists.
    SUPABASE_DB_PASSWORD: "test-placeholder-password",
    ...(built.binaryOverride ? { SUPABASE_CLI_BINARY_OVERRIDE: built.binaryOverride } : {}),
    ...opts?.env,
  };

  // The CLI resolves its API base URL through the profile system, not
  // SUPABASE_API_URL: `CommandSettings` accepts a built-in profile name or a YAML
  // file path, and the still-proxied Go binary reads the same file via
  // SUPABASE_PROFILE. Write a temp profile file pointing at the replay server so
  // both paths reach it.
  const profilePath = path.join(tmpdir(), `cli-e2e-profile-${randomUUID()}.yaml`);
  const url = harness.options.apiUrl;
  const profile = [
    `name: test`,
    `api_url: "${url}"`,
    `dashboard_url: "${url}"`,
    `project_host: ${harness.options.projectHost ?? "localhost"}`,
  ].join("\n");
  const command = [...built.cmd, ...args];
  // Default to os.tmpdir() so subprocess file writes never land in the repo
  const cwd = harness.options.cwd ?? tmpdir();

  yield* assertTsCliBuilt(fs, tsCliShim, tsCliBinary);
  yield* fs.writeFileString(profilePath, profile);
  env["SUPABASE_PROFILE"] = profilePath;

  const proc = yield* Effect.try({
    try: () =>
      Bun.spawn(command, {
        env,
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      }),
    catch: (cause) => new SubprocessError({ cause }),
  });

  const [stdout, stderr] = yield* Effect.all([readText(proc.stdout), readText(proc.stderr)], {
    concurrency: "unbounded",
  });

  const exitCode = yield* Effect.tryPromise({
    try: () => proc.exited,
    catch: (cause) => new SubprocessError({ cause }),
  });
  const durationMs = performance.now() - start;

  if (profilePath) yield* fs.remove(profilePath, { force: true });

  return { stdout, stderr, exitCode, durationMs };
});

export function exec(
  harness: CLIHarness,
  args: string[],
  opts?: { env?: Record<string, string> },
): Promise<CLIResult> {
  return runHarness(execEffect(harness, args, opts));
}
