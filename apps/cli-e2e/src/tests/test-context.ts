import { inject, test } from "vitest";
import {
  createHarness,
  exec,
  makeTempDir,
  type CLIResult,
  type TempDir,
} from "@supabase/cli-test-helpers";
import { ACCESS_TOKEN, TARGET } from "./env.ts";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function scenarioSlug(task: { name: string; suite?: { name: string } | null }): string {
  const prefix = task.suite?.name ? slugify(task.suite.name) + "-" : "";
  return prefix + slugify(task.name);
}

type ExecOptions = NonNullable<Parameters<typeof exec>[2]>;

interface BehaviourFixtures {
  projectRef: string;
  orgId: string;
  workspace: TempDir;
  run: (cmd: string[], execOpts?: ExecOptions) => Promise<CLIResult>;
  runNoProjectId: (cmd: string[]) => Promise<CLIResult>;
  apiUrl: string;
  storageBucket: string;
  pgMockPort: number;
}

/** Custom test function for behavioural CLI tests.
 *
 *  Provides per-test:
 *  - `projectRef` — a real project ref (record mode) or the replay default
 *  - `orgId` — a real org slug (record mode) or the replay default
 *  - `workspace` — fresh temp dir, auto-disposed after the test
 *  - `run` — pre-configured `exec()` for the current TARGET (optional second
 *    argument forwarded as `exec` options, e.g. extra `env` entries)
 *  - `apiUrl` — the replay server base URL (for setting up error overrides)
 *
 *  Auto-wires a named scenario for the test before running it, so the replay
 *  server knows which ordered interaction sequence to serve. Auto-clears the
 *  request log, error overrides, and active scenario after every test. */
export const testBehaviour = test.extend<BehaviourFixtures>({
  // eslint-disable-next-line no-empty-pattern
  projectRef: async ({}, use) => {
    await use(inject("projectRef") as string);
  },

  // eslint-disable-next-line no-empty-pattern
  orgId: async ({}, use) => {
    await use(inject("orgId") as string);
  },

  workspace: async ({ task }, use) => {
    const serverUrl = inject("replayServerUrl");
    const slug = scenarioSlug(task);
    // Truncate to 40 chars to keep temp dir names manageable.
    const dir = makeTempDir(`cli-e2e-${slug.slice(0, 40)}-`);

    const res = await fetch(`${serverUrl}/_ctrl/scenario`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: slug }),
    });
    if (!res.ok) {
      dir[Symbol.dispose]();
      const { message } = (await res.json()) as { message: string };
      throw new Error(message);
    }

    await use(dir);

    dir[Symbol.dispose]();
    await Promise.all([
      fetch(`${serverUrl}/_ctrl/requests`, { method: "DELETE" }),
      fetch(`${serverUrl}/_ctrl/overrides`, { method: "DELETE" }),
      fetch(`${serverUrl}/_ctrl/scenario`, { method: "DELETE" }),
    ]);
  },

  run: async ({ workspace }, use) => {
    const serverUrl = inject("replayServerUrl");
    const harness = createHarness(TARGET, {
      apiUrl: serverUrl,
      accessToken: ACCESS_TOKEN,
      cwd: workspace.path,
      projectId: inject("projectRef") as string,
    });
    await use((cmd, execOpts) => exec(harness, cmd, execOpts));
  },

  runNoProjectId: async ({ workspace }, use) => {
    const serverUrl = inject("replayServerUrl");
    const harness = createHarness(TARGET, {
      apiUrl: serverUrl,
      accessToken: ACCESS_TOKEN,
      cwd: workspace.path,
    });
    await use((cmd) => exec(harness, cmd));
  },

  // eslint-disable-next-line no-empty-pattern
  storageBucket: async ({}, use) => {
    await use(inject("storageBucket") as string);
  },

  // eslint-disable-next-line no-empty-pattern
  apiUrl: async ({}, use) => {
    await use(inject("replayServerUrl"));
  },

  // eslint-disable-next-line no-empty-pattern
  pgMockPort: async ({}, use) => {
    await use(inject("pgMockPort") as number);
  },
});
