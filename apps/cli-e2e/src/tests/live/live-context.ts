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
import {
  ACCESS_TOKEN,
  type Capability,
  isLive,
  PROJECT_HOST,
  PROVIDED_CAPABILITIES,
  TARGET,
  TARGET_API_URL,
} from "../env.ts";
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
    // Sanitize the task name: it becomes part of the temp-dir path, which the cli
    // mounts as a Docker volume for docker-backed commands (functions bundling,
    // db diff shadow). A `:` or space in the path breaks the `src:dst:mode`
    // volume spec ("too many colons"), so collapse anything non-alphanumeric.
    const safeName = task.name.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 30);
    const dir = makeTempDir(`cli-e2e-live-${safeName}-`);
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

/** Live test API that additionally skips unless the target env provides every
 *  required runtime capability (docker / internet / external-tool). Lets one
 *  suite run against staging (all capabilities → runs everything, the oracle),
 *  supabox (only what it currently supports), and Antithesis (offline subset),
 *  each skipping only what it genuinely can't do. Put the requirement in the test
 *  name (e.g. "[C5] … (docker+internet)") so a skip reads clearly in the report. */
export function testLiveRequires(required: readonly Capability[]): typeof testLive {
  const missing = required.filter((capability) => !PROVIDED_CAPABILITIES.has(capability));
  return missing.length === 0 ? testLive : testLive.skip;
}
