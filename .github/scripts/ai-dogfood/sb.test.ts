import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

const SB_SH = join(import.meta.dir, "../../ai-dogfood/sb.sh");

const temporaryDirectories: string[] = [];

function makeHarness(): {
  runnerTemp: string;
  tokenFile: string;
  prefixFile: string;
  dummyCli: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ai-dogfood-sb-"));
  temporaryDirectories.push(root);
  const runnerTemp = join(root, "runner-temp");
  mkdirSync(runnerTemp);
  const tokenFile = join(runnerTemp, "dogfood.token");
  const prefixFile = join(root, "project-prefix.txt");
  const dummyCli = join(root, "dummy-cli.ts");
  writeFileSync(tokenFile, "sbp_testtokenvalue000000000000");
  writeFileSync(prefixFile, "supabase-cli-dogfood-1-");
  writeFileSync(dummyCli, 'console.log(process.argv.slice(2).join(" "));\n');
  return { runnerTemp, tokenFile, prefixFile, dummyCli };
}

function runSb(
  args: string[],
  env: Record<string, string | undefined>,
): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync("bash", [SB_SH, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("sb.sh", () => {
  test("fails when the token file is missing", () => {
    const { runnerTemp, prefixFile, dummyCli } = makeHarness();
    const { status, stderr } = runSb(["--version"], {
      DOGFOOD_CLI_MAIN: dummyCli,
      RUNNER_TEMP: runnerTemp,
      DOGFOOD_TOKEN_FILE: join(runnerTemp, "missing.token"),
      DOGFOOD_PROJECT_PREFIX_FILE: prefixFile,
    });
    expect(status).toBe(1);
    expect(stderr).toContain("missing token file");
  });

  test("fails when the token file is empty", () => {
    const { tokenFile, prefixFile, runnerTemp, dummyCli } = makeHarness();
    writeFileSync(tokenFile, "  \n");
    const { status, stderr } = runSb(["--version"], {
      DOGFOOD_CLI_MAIN: dummyCli,
      RUNNER_TEMP: runnerTemp,
      DOGFOOD_TOKEN_FILE: tokenFile,
      DOGFOOD_PROJECT_PREFIX_FILE: prefixFile,
    });
    expect(status).toBe(1);
    expect(stderr).toContain("token file");
    expect(stderr).toContain("empty");
  });

  test("rejects projects create without the required prefix", () => {
    const { tokenFile, prefixFile, runnerTemp, dummyCli } = makeHarness();
    const { status, stderr } = runSb(["projects", "create", "unrelated-name", "--org-id", "org"], {
      DOGFOOD_CLI_MAIN: dummyCli,
      RUNNER_TEMP: runnerTemp,
      DOGFOOD_TOKEN_FILE: tokenFile,
      DOGFOOD_PROJECT_PREFIX_FILE: prefixFile,
    });
    expect(status).toBe(1);
    expect(stderr).toContain("must start with supabase-cli-dogfood-1-");
  });

  test("allows projects create when a later argument carries the prefix", () => {
    const { tokenFile, prefixFile, runnerTemp, dummyCli } = makeHarness();
    const { status, stdout } = runSb(
      ["projects", "create", "--org-id", "org", "supabase-cli-dogfood-1-abc"],
      {
        DOGFOOD_CLI_MAIN: dummyCli,
        RUNNER_TEMP: runnerTemp,
        DOGFOOD_TOKEN_FILE: tokenFile,
        DOGFOOD_PROJECT_PREFIX_FILE: prefixFile,
      },
    );
    expect(status).toBe(0);
    expect(stdout).toContain("projects create --org-id org supabase-cli-dogfood-1-abc");
  });

  test("does not treat a prefixed flag value as the project name", () => {
    const { tokenFile, prefixFile, runnerTemp, dummyCli } = makeHarness();
    const { status, stderr } = runSb(
      ["projects", "create", "unrelated-name", "--db-password", "supabase-cli-dogfood-1-secret"],
      {
        DOGFOOD_CLI_MAIN: dummyCli,
        RUNNER_TEMP: runnerTemp,
        DOGFOOD_TOKEN_FILE: tokenFile,
        DOGFOOD_PROJECT_PREFIX_FILE: prefixFile,
      },
    );
    expect(status).toBe(1);
    expect(stderr).toContain("must start with supabase-cli-dogfood-1-");
  });
});
