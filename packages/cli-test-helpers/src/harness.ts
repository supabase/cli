import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

export type CLITarget = "go" | "ts-legacy" | "ts-next";

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
  /** Set as SUPABASE_PROJECT_ID in the subprocess env. Storage commands read
   *  this via viper (no --project-ref flag) for config validation in --local mode. */
  projectId?: string;
}

export interface CLIHarness {
  readonly target: CLITarget;
  readonly options: HarnessOptions;
}

/** A temporary directory that is removed when disposed. */
export interface TempDir {
  readonly path: string;
  [Symbol.dispose](): void;
}

/** Create a unique temporary directory under os.tmpdir() for use as a CLI
 *  working directory. Dispose it after the test to clean up. */
export function makeTempDir(prefix = "cli-e2e-"): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    [Symbol.dispose]() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

// Resolve the monorepo root from this file's location:
// packages/cli-test-helpers/src/harness.ts -> ../../../ = repo root
const WORKSPACE_ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

function buildCommand(target: CLITarget): string[] {
  switch (target) {
    case "go":
      return [process.env["SUPABASE_GO_BINARY"] ?? "supabase"];
    case "ts-legacy":
      return ["bun", join(WORKSPACE_ROOT, "apps/cli/dist/main-legacy.js")];
    case "ts-next":
      return ["bun", join(WORKSPACE_ROOT, "apps/cli/dist/main-next.js")];
  }
}

export function createHarness(target: CLITarget, options: HarnessOptions): CLIHarness {
  return { target, options };
}

export async function exec(
  harness: CLIHarness,
  args: string[],
  opts?: { env?: Record<string, string> },
): Promise<CLIResult> {
  const start = performance.now();
  const cmd = buildCommand(harness.target);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SUPABASE_ACCESS_TOKEN: harness.options.accessToken,
    SUPABASE_NO_KEYRING: "true",
    SUPABASE_TELEMETRY_DISABLED: "1",
    // Isolate CLI filesystem side-effects (e.g. telemetry.json) to the CWD so
    // tests don't touch the developer's real ~/.supabase and parity tests can
    // track file changes via snapshotChangedFiles().
    SUPABASE_HOME: harness.options.cwd ?? tmpdir(),
    ...(harness.options.projectId ? { SUPABASE_PROJECT_ID: harness.options.projectId } : {}),
    // When a test writes a pooler-url file the Go CLI takes the pooler path in
    // ParseDatabaseConfig. Setting a non-empty password avoids the initPoolerLogin
    // API call so the only network traffic is the actual Management API call
    // under test. Safe to set globally: it is only used when pooler-url exists.
    SUPABASE_DB_PASSWORD: "test-placeholder-password",
    ...opts?.env,
  };

  // The Go CLI (and the ts-legacy CLI which shells out to Go) uses a profile
  // system rather than SUPABASE_API_URL. Write a temporary profile file
  // pointing to the replay server. SUPABASE_PROFILE is picked up by Go's viper
  // (prefix SUPABASE_ + AutomaticEnv). For ts-legacy, the profile file is
  // inherited by the Go subprocess because it spawns with extendEnv: true.
  // ts-next reads SUPABASE_API_URL directly, so it doesn't need a profile file.
  let profilePath: string | undefined;
  if (harness.target === "go" || harness.target === "ts-legacy") {
    profilePath = join(tmpdir(), `cli-e2e-profile-${randomUUID()}.yaml`);
    const url = harness.options.apiUrl;
    writeFileSync(
      profilePath,
      [
        `name: test`,
        `api_url: "${url}"`,
        `dashboard_url: "${url}"`,
        `project_host: localhost`,
      ].join("\n"),
    );
    env["SUPABASE_PROFILE"] = profilePath;
  } else {
    env["SUPABASE_API_URL"] = harness.options.apiUrl;
  }

  const proc = Bun.spawn([...cmd, ...args], {
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

  if (profilePath) rmSync(profilePath, { force: true });

  return { stdout, stderr, exitCode, durationMs };
}
