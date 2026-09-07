// This is a compiled CLI boundary test. It deliberately starts the native owner through the
// built binary, then uses the package's public Promise API only to inspect and destroy that exact
// stack after the CLI process has exited.
// oxlint-disable-next-line effecttsgo/process-env -- package runtime composition is scoped below.

import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { makeTempHome, runSupabase } from "../../../../../tests/helpers/cli.ts";

const START_TIMEOUT_MS = 15 * 60_000;
const CLEANUP_TIMEOUT_MS = 120_000;
const execFile = promisify(execFileCallback);
const nativeSupported =
  (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) ||
  (process.platform === "darwin" && process.arch === "arm64");

const minimalConfig = `project_id = "compiled-stack-start-e2e"

[api]
enabled = false

[auth]
enabled = false

[db.pooler]
enabled = false

[edge_runtime]
enabled = false

[realtime]
enabled = false

[storage]
enabled = false

[studio]
enabled = false

[analytics]
enabled = false

[local_smtp]
enabled = false
`;

async function inspectAndDestroyStack(home: string, stackId: string) {
  const script = `
    import { inspectStack, openStack, StackIdSchema } from "@supabase/stack";
    const id = StackIdSchema.make(process.argv.at(-1));
    const inspection = await inspectStack(id);
    const stack = await openStack(id);
    const status = await stack.status();
    await stack.destroy();
    console.log(JSON.stringify({
      owner: inspection.owner,
      projectRoot: inspection.descriptor.projectRoot,
      runtime: status.runtime,
      lifecycle: status.lifecycle,
      database: status.capabilities.find(({ name }) => name === "database")?.state,
    }));
  `;
  const result = await execFile("bun", ["--bun", "-e", script, stackId], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SUPABASE_HOME: home,
      SUPABASE_NO_KEYRING: "1",
      SUPABASE_TELEMETRY_DISABLED: "1",
    },
    timeout: CLEANUP_TIMEOUT_MS,
  });
  const line = result.stdout.trim().split("\n").at(-1);
  if (line === undefined) throw new Error(`Stack probe returned no result:\n${result.stderr}`);
  return JSON.parse(line) as {
    readonly owner: string;
    readonly projectRoot: string;
    readonly runtime: { readonly kind: string };
    readonly lifecycle: string;
    readonly database: string | undefined;
  };
}

describe("experimental stack start (compiled e2e)", () => {
  let home: ReturnType<typeof makeTempHome> | undefined;
  let projectDir: string | undefined;
  let stackId: string | undefined;
  let stackDestroyed = false;

  afterEach(async () => {
    let cleanupComplete = stackDestroyed;
    if (!cleanupComplete && home !== undefined) {
      const candidates = await readdir(path.join(home.dir, "managed", "stacks")).catch(
        () => [] as Array<string>,
      );
      const discovered = candidates.filter((entry) => /^[0-9a-f]{64}$/u.test(entry));
      const ownedId = stackId ?? (discovered.length === 1 ? discovered[0] : undefined);
      if (ownedId !== undefined) {
        await inspectAndDestroyStack(home.dir, ownedId);
        cleanupComplete = true;
      } else if (discovered.length > 1) {
        throw new Error(`Could not identify one owned stack for cleanup: ${discovered.join(", ")}`);
      } else {
        cleanupComplete = true;
      }
    }
    if (!cleanupComplete) return;
    if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true });
    home?.[Symbol.dispose]();
    home = undefined;
    projectDir = undefined;
    stackId = undefined;
    stackDestroyed = false;
  }, CLEANUP_TIMEOUT_MS);

  test.skipIf(!nativeSupported)(
    "starts a detached native owner and leaves a ready database after CLI exit",
    { timeout: START_TIMEOUT_MS + CLEANUP_TIMEOUT_MS },
    async () => {
      home = makeTempHome();
      projectDir = await mkdtemp(path.join("/tmp", "supabase-compiled-stack-start-e2e-"));
      await mkdir(path.join(projectDir, "supabase"), { recursive: true });
      await writeFile(path.join(projectDir, "supabase", "config.toml"), minimalConfig);

      const result = await runSupabase(
        ["experimental", "stack", "start", "--runtime", "native", "--eager"],
        {
          entrypoint: "legacy",
          cwd: projectDir,
          home: home.dir,
          exitTimeoutMs: START_TIMEOUT_MS,
        },
      );
      expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      const idMatch = result.stdout.match(/Stack ([0-9a-f]{64})/u);
      expect(idMatch, `stdout:\n${result.stdout}`).not.toBeNull();
      stackId = idMatch?.[1];
      const idText = stackId;
      const homeDir = home;
      const projectRoot = projectDir;
      if (idText === undefined || homeDir === undefined || projectRoot === undefined)
        throw new Error("compiled start did not return a stack id");

      const observed = await inspectAndDestroyStack(homeDir.dir, idText);
      stackDestroyed = true;
      expect(observed.owner).toBe("running");
      expect(observed.projectRoot).toBe(await realpath(projectRoot));
      expect(observed.runtime).toEqual({ kind: "native" });
      expect(observed.lifecycle).toBe("running");
      expect(observed.database).toBe("ready");

      await expect(access(path.join(homeDir.dir, "managed", "stacks", idText))).rejects.toThrow();
    },
  );
});
