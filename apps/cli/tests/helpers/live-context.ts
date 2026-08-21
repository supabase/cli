import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { inject, test } from "vitest";

import { makeTempHome } from "./cli.ts";
import { runSupabaseLive } from "./live.ts";
import {
  isLiveConfigured,
  isManagedLive,
  liveProjectDataPlaneReady,
  liveProjectRef,
} from "./live-env.ts";

type RunOptions = NonNullable<Parameters<typeof runSupabaseLive>[1]>;
type RunResult = Awaited<ReturnType<typeof runSupabaseLive>>;
type TempHome = ReturnType<typeof makeTempHome>;

export interface LiveWorkspace {
  readonly path: string;
}

export interface InvokeResult {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

export interface LiveFixtures {
  readonly projectRef: string;
  readonly anonKey: string;
  readonly functionsUrl: string;
  readonly dbUrl: string;
  readonly dbPassword: string;
  readonly storageBucket: string;
  readonly home: TempHome;
  readonly workspace: LiveWorkspace;
  readonly run: (args: string[], options?: RunOptions) => Promise<RunResult>;
  readonly invoke: (
    slug: string,
    options?: { anonKey?: string; payload?: unknown },
  ) => Promise<InvokeResult>;
}

const base = test.extend<LiveFixtures>({
  // eslint-disable-next-line no-empty-pattern
  projectRef: async ({}, use) => {
    await use(inject("projectRef"));
  },

  // eslint-disable-next-line no-empty-pattern
  anonKey: async ({}, use) => {
    await use(inject("anonKey"));
  },

  // eslint-disable-next-line no-empty-pattern
  functionsUrl: async ({}, use) => {
    await use(inject("functionsUrl"));
  },

  // eslint-disable-next-line no-empty-pattern
  dbUrl: async ({}, use) => {
    await use(inject("dbUrl"));
  },

  // eslint-disable-next-line no-empty-pattern
  dbPassword: async ({}, use) => {
    await use(inject("dbPassword"));
  },

  // eslint-disable-next-line no-empty-pattern
  storageBucket: async ({}, use) => {
    await use(inject("storageBucket"));
  },

  home: async ({ task: _task }, use) => {
    const home = makeTempHome();
    try {
      await use(home);
    } finally {
      home[Symbol.dispose]();
    }
  },

  workspace: async ({ task, home }, use) => {
    const suffix = task.name.replace(/[^a-z0-9-]+/giu, "-").slice(0, 40);
    const directory = mkdtempSync(path.join(tmpdir(), `supabase-live-${suffix || "test"}-`));
    try {
      const initialized = await runSupabaseLive(["init"], {
        cwd: directory,
        home: home.dir,
      });
      if (initialized.exitCode !== 0) {
        throw new Error(
          `supabase init failed (exit ${initialized.exitCode})\n${initialized.stderr || initialized.stdout}`,
        );
      }
      await use({ path: directory });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },

  run: async ({ workspace, home }, use) => {
    await use((args, options) =>
      runSupabaseLive(args, {
        ...options,
        cwd: options?.cwd ?? workspace.path,
        // A test may use a subdirectory as cwd, but must share this HOME so
        // setup/command/teardown observe the same link and config state.
        home: home.dir,
      }),
    );
  },

  invoke: async ({ functionsUrl, anonKey }, use) => {
    await use(async (slug, options) => {
      const key = options?.anonKey ?? anonKey;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (key.length > 0) {
        headers["Authorization"] = `Bearer ${key}`;
        headers["apikey"] = key;
      }
      const response = await fetch(`${functionsUrl}/${slug}`, {
        method: "POST",
        headers,
        body: JSON.stringify(options?.payload ?? {}),
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: response.status, body, text };
    });
  },
});

/** Live subprocess fixture. The global setup owns the shared platform project;
 * this fixture owns only one isolated workspace and HOME per test. */
export const testLive = base.skipIf(!isLiveConfigured());

/** Fixture for scenarios that require a project ref from managed or attached setup. */
export const testLiveProject = base.skipIf(!isLiveConfigured() || !liveProjectRef());

/** Fixture for Edge Function deploy/invoke scenarios. */
export const testLiveFunctions = base.skipIf(
  !isLiveConfigured() ||
    !liveProjectRef() ||
    (!isManagedLive() && (process.env["SUPABASE_LIVE_ANON_KEY"] ?? "").length === 0),
);

/** Fixture for scenarios that require the project's Postgres data plane. */
export const testLiveDataPlane = base.skipIf(!(await liveProjectDataPlaneReady()));

/** Fixture for remote database tests that create/drop transient schema state. */
export const testLiveDestructiveDataPlane = base.skipIf(
  !(await liveProjectDataPlaneReady()) ||
    (!isManagedLive() && process.env["SUPABASE_LIVE_ALLOW_DESTRUCTIVE"] !== "1"),
);

/** Fixture for Storage scenarios requiring a linked database password. */
export const testLiveStorage = base.skipIf(
  !(await liveProjectDataPlaneReady()) ||
    !liveProjectRef() ||
    (!isManagedLive() &&
      ((process.env["SUPABASE_LIVE_DB_PASSWORD"] ?? "").length === 0 ||
        (process.env["SUPABASE_LIVE_STORAGE_BUCKET"] ?? "").length === 0)),
);

/** Throw with command diagnostics when a setup/teardown command fails. */
export function requireLiveSuccess(
  result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
  command: string,
): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} failed (exit ${result.exitCode})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

/** Resolve a remote database target without requiring staging-only pooler data. */
export function liveDatabaseTargetArgs(dbUrl: string, projectRef: string): string[] {
  if (dbUrl.length > 0) return ["--db-url", dbUrl];
  if (projectRef.length === 0) {
    throw new Error("A project ref is required when SUPABASE_LIVE_DB_URL is unavailable");
  }
  return ["--linked", "--project-ref", projectRef];
}

export function expectFunctionOk(
  result: InvokeResult,
  slug: string,
  extra?: Record<string, unknown>,
): void {
  if (result.status !== 200) {
    throw new Error(
      `Expected function ${slug} to return 200, got ${result.status}: ${result.text}`,
    );
  }
  if (typeof result.body !== "object" || result.body === null) {
    throw new Error(`Expected function ${slug} to return JSON: ${result.text}`);
  }
  const body = result.body as Record<string, unknown>;
  if (body.case !== slug || body.ok !== true) {
    throw new Error(`Unexpected response from ${slug}: ${result.text}`);
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (body[key] !== value) throw new Error(`Unexpected ${key} from ${slug}: ${result.text}`);
  }
}
