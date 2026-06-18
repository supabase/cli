import { appendFileSync, cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inject, test } from "vitest";
import {
  createHarness,
  exec,
  makeTempDir,
  type CLIResult,
  type TempDir,
} from "@supabase/cli-test-helpers";
import { ACCESS_TOKEN, isLive, PROJECT_HOST, TARGET, TARGET_API_URL } from "../env.ts";
import { invokeFunction, type InvokeResult } from "./invoke.ts";

type ExecOptions = NonNullable<Parameters<typeof exec>[2]>;

// deploy-e2e-* function files (functions/, import_map.json, assets/) + the
// [functions.*] config snippet, layered onto an init-generated config by
// seedFunctions() for the functions deploy tests.
const FUNCTIONS_PROJECT_DIR = new URL("../../../fixtures/live/functions-project", import.meta.url)
  .pathname;
const FUNCTIONS_CONFIG_SNIPPET = new URL(
  "../../../fixtures/live/functions-config.toml",
  import.meta.url,
).pathname;

function liveHarness(cwd: string) {
  return createHarness(TARGET, {
    apiUrl: TARGET_API_URL,
    accessToken: ACCESS_TOKEN,
    cwd,
    projectId: inject("projectRef"),
    // Real host so host-derived commands (storage --linked → <ref>.<host>) reach
    // the live endpoint instead of localhost.
    projectHost: PROJECT_HOST,
  });
}

/** Layer the deploy-e2e-* function files + their [functions.*] config onto an
 *  init-generated workspace. Used by the functions deploy tests; every other
 *  test runs against the bare `supabase init` config. */
export function seedFunctions(workspacePath: string): void {
  const supabaseDir = join(workspacePath, "supabase");
  cpSync(FUNCTIONS_PROJECT_DIR, supabaseDir, { recursive: true });
  appendFileSync(
    join(supabaseDir, "config.toml"),
    `\n${readFileSync(FUNCTIONS_CONFIG_SNIPPET, "utf8")}`,
  );
}

interface LiveFixtures {
  projectRef: string;
  anonKey: string;
  functionsUrl: string;
  dbUrl: string;
  dbPassword: string;
  storageBucket: string;
  workspace: TempDir;
  run: (cmd: string[], execOpts?: ExecOptions) => Promise<CLIResult>;
  invoke: (slug: string, opts?: { anonKey?: string; payload?: unknown }) => Promise<InvokeResult>;
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

  workspace: async ({ task }, use) => {
    const dir = makeTempDir(`cli-e2e-live-${task.name.slice(0, 30)}-`);
    // Generate config.toml via `supabase init` so the golden paths run against a
    // freshly-generated config (functions tests add functions via seedFunctions).
    const init = await exec(liveHarness(dir.path), ["init"]);
    if (init.exitCode !== 0) throw new Error(`supabase init failed: ${init.stderr}`);
    await use(dir);
    dir[Symbol.dispose]();
  },

  run: async ({ workspace }, use) => {
    const harness = liveHarness(workspace.path);
    await use((cmd, execOpts) => exec(harness, cmd, execOpts));
  },

  invoke: async ({ functionsUrl, anonKey }, use) => {
    await use((slug, opts) =>
      invokeFunction({
        functionsUrl,
        slug,
        anonKey: opts && "anonKey" in opts ? opts.anonKey : anonKey,
        payload: opts?.payload,
      }),
    );
  },
});

/** Live test API — skipped unless CLI_E2E_MODE=live, so files are inert on
 *  replay/PR runs (and globalSetup provisions nothing). */
export const testLive = base.skipIf(!isLive);
