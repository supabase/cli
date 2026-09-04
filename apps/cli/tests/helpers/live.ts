import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Predicate } from "effect";
import pg from "pg";
import { expect, inject, test as vitestTest } from "vitest";

import { makeTempHome, runSupabase } from "./cli.ts";
import { LIVE_EXIT_TIMEOUT_MS } from "./live-env.ts";
import type { LiveCliProjectEnvironment } from "./live-project.ts";

export type LiveProject = LiveCliProjectEnvironment["project"];
type RunOptions = NonNullable<Parameters<typeof runSupabase>[1]>;
type RunResult = Awaited<ReturnType<typeof runSupabase>>;

export interface LiveWorkspace {
  readonly path: string;
}

export interface InvokeResult {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

export interface LiveFixtures {
  readonly project: LiveProject;
  readonly workspace: LiveWorkspace;
  readonly home: ReturnType<typeof makeTempHome>;
  readonly cli: (args: string[], options?: RunOptions) => Promise<RunResult>;
  readonly invoke: (
    slug: string,
    options?: { readonly anonKey?: string; readonly payload?: unknown },
  ) => Promise<InvokeResult>;
}

const base = vitestTest.extend<LiveFixtures>({
  // eslint-disable-next-line no-empty-pattern
  project: async ({}, use) => use(inject("liveProject")),

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
      const initialized = await runSupabase(["init"], {
        entrypoint: "legacy",
        cwd: directory,
        home: home.dir,
        env: { SUPABASE_PROFILE: inject("liveProfilePath") },
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

  cli: async ({ workspace, home }, use) => {
    await use((args, options) =>
      runSupabase(args, {
        entrypoint: "legacy",
        ...options,
        cwd: options?.cwd ?? workspace.path,
        home: home.dir,
        exitTimeoutMs: options?.exitTimeoutMs ?? LIVE_EXIT_TIMEOUT_MS,
        env: {
          SUPABASE_PROFILE: inject("liveProfilePath"),
          ...options?.env,
        },
      }),
    );
  },

  invoke: async ({ project }, use) => {
    await use(async (slug, options) => {
      const key = options?.anonKey ?? project.anonKey;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (key.length > 0) {
        headers["Authorization"] = `Bearer ${key}`;
        headers["apikey"] = key;
      }
      const response = await fetch(`${project.functionsUrl}/${slug}`, {
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

/** The sole live fixture. The live global setup owns the shared project. */
export const test = base;

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

/** Flags every storage live test passes: the suite links the shared project
 * and the storage command family is experimental-gated. */
export const storageLiveFlags: ReadonlyArray<string> = ["--linked", "--experimental"];

/**
 * Best-effort exact-object cleanup for storage live tests: removes one owned
 * remote object, tolerating an already-removed target so teardown stays
 * idempotent across the moved/renamed paths a test may leave behind.
 */
export async function removeStorageLiveObject(
  cli: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  remote: string,
): Promise<void> {
  const removed = await cli(["storage", "rm", remote, "--yes", ...storageLiveFlags]);
  if (
    removed.exitCode !== 0 &&
    !/not found|does not exist/i.test(`${removed.stdout}\n${removed.stderr}`)
  ) {
    throw new Error(`storage rm cleanup failed:\n${removed.stdout}\n${removed.stderr}`);
  }
}

/** Flags for experimental-gated live tests that address the shared project by
 * ref rather than linking it (contrast `storageLiveFlags`). */
export function experimentalProjectLiveFlags(project: LiveProject): ReadonlyArray<string> {
  return ["--project-ref", project.ref, "--experimental"];
}

/**
 * Exact-key cleanup for postgres-config live tests: removes one owned override
 * without a database restart. Deleting an absent key is a no-op PUT, so the
 * teardown stays idempotent.
 */
export async function removePostgresConfigLiveOverride(
  cli: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  project: LiveProject,
  key: string,
): Promise<void> {
  const removed = await cli([
    "postgres-config",
    "delete",
    "--config",
    key,
    ...experimentalProjectLiveFlags(project),
    "--no-restart",
  ]);
  requireLiveSuccess(removed, `postgres-config delete cleanup for ${key}`);
}

export function expectPostgresConfigLiveOverride(
  cli: LiveFixtures["cli"],
  project: LiveProject,
  key: string,
  expected: string | undefined,
  label: string,
): Promise<void> {
  return expect
    .poll(
      async () => {
        const proof = await cli(
          ["postgres-config", "get", ...experimentalProjectLiveFlags(project), "-o", "json"],
          { exitTimeoutMs: 20_000 },
        );
        requireLiveSuccess(proof, label);
        let config: unknown;
        try {
          config = JSON.parse(proof.stdout);
        } catch {
          config = undefined;
        }
        if (!Predicate.isObject(config)) {
          throw new Error(
            `${label}: unexpected postgres-config get payload\nstdout:\n${proof.stdout}\nstderr:\n${proof.stderr}`,
          );
        }
        return config[key];
      },
      { interval: 2_000, timeout: 60_000, message: label },
    )
    .toBe(expected);
}

/**
 * Unique migration version for a live test: a sortable `YYYYMMDDHHMMSS` UTC
 * stamp plus four random digits, so it always orders after any conventional
 * timestamp version already in the shared project's migration history.
 */
export function liveMigrationVersion(): string {
  const stamp = new Date()
    .toISOString()
    .replaceAll(/[-:TZ.]/gu, "")
    .slice(0, 14);
  return `${stamp}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, "0")}`;
}

/**
 * Runs one query against the live project over a direct pg connection, so
 * live assertions can verify database state without invoking another CLI
 * command.
 */
export async function queryLiveDb<T extends Record<string, unknown>>(
  dbUrl: string,
  query: string,
  values?: ReadonlyArray<unknown>,
): Promise<T[]> {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const result = await client.query(query, values === undefined ? undefined : [...values]);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

/** Rethrow a target failure without discarding failures from exact cleanup. */
export function throwWithCleanup(primary: unknown, cleanup: ReadonlyArray<unknown>): void {
  if (primary !== undefined) {
    if (cleanup.length > 0) {
      throw new AggregateError([primary, ...cleanup], "Live e2e target and cleanup failed");
    }
    throw primary;
  }
  if (cleanup.length === 1) throw cleanup[0];
  if (cleanup.length > 1) throw new AggregateError(cleanup, "Live e2e cleanup failed");
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
