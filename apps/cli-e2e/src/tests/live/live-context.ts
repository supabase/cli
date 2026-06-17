import { cpSync } from "node:fs";
import { join } from "node:path";
import { inject, test } from "vitest";
import {
  createHarness,
  exec,
  makeTempDir,
  type CLIResult,
  type TempDir,
} from "@supabase/cli-test-helpers";
import { ACCESS_TOKEN, isLive, TARGET, TARGET_API_URL } from "../env.ts";
import { invokeFunction, type InvokeResult } from "./invoke.ts";

type ExecOptions = NonNullable<Parameters<typeof exec>[2]>;

// The migrated supabase/ project tree (config.toml + deploy-e2e-* functions),
// copied fresh into each test's workspace.
const FUNCTIONS_PROJECT_DIR = new URL("../../../fixtures/live/functions-project", import.meta.url)
  .pathname;

interface LiveFixtures {
  projectRef: string;
  anonKey: string;
  functionsUrl: string;
  dbUrl: string;
  workspace: TempDir;
  run: (cmd: string[], execOpts?: ExecOptions) => Promise<CLIResult>;
  invoke: (slug: string, opts?: { anonKey?: string; payload?: unknown }) => Promise<InvokeResult>;
}

const base = test.extend<LiveFixtures>({
  // eslint-disable-next-line no-empty-pattern
  projectRef: async ({}, use) => {
    await use(inject("projectRef") as string);
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

  workspace: async ({ task }, use) => {
    const dir = makeTempDir(`cli-e2e-live-${task.name.slice(0, 30)}-`);
    // CLI expects a `supabase/` directory containing config.toml + functions/.
    cpSync(FUNCTIONS_PROJECT_DIR, join(dir.path, "supabase"), { recursive: true });
    await use(dir);
    dir[Symbol.dispose]();
  },

  run: async ({ workspace }, use) => {
    const harness = createHarness(TARGET, {
      apiUrl: TARGET_API_URL,
      accessToken: ACCESS_TOKEN,
      cwd: workspace.path,
      projectId: inject("projectRef") as string,
    });
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
