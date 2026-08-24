// oxlint-disable effecttsgo/async-function -- this e2e test uses Vitest's Promise surface to drive the real CLI.
import { afterEach, expect, test } from "vitest";

import { describe } from "vitest";
import {
  makeTempLegacyStackProject,
  requireCliSuccess,
  runSupabase,
} from "../../../../tests/helpers/cli.ts";

const CLI_COMMAND_TIMEOUT_MS = 60_000;
const STACK_START_TIMEOUT_MS = 280_000;
const STATUS_COMMAND_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 120_000;
const LIFECYCLE_MARGIN_MS = 30_000;
const CLEANUP_HOOK_TIMEOUT_MS = CLEANUP_TIMEOUT_MS + LIFECYCLE_MARGIN_MS;
const STATUS_TEST_TIMEOUT_MS =
  CLI_COMMAND_TIMEOUT_MS +
  STACK_START_TIMEOUT_MS +
  STATUS_COMMAND_TIMEOUT_MS * 2 +
  LIFECYCLE_MARGIN_MS;

// See stop.e2e.test.ts for why `describe` (not a Management-API gate) is
// the right reuse here: `status` never calls the Management API, only the real
// Docker daemon the cli-e2e-ci runner provides. See AGENTS.md's "e2e tests"
// section for the full convention.
describe("supabase status (e2e)", () => {
  let project: Awaited<ReturnType<typeof makeTempLegacyStackProject>> | undefined;

  afterEach(async () => {
    await project?.cleanup().catch(() => undefined);
    project = undefined;
  }, CLEANUP_HOOK_TIMEOUT_MS);

  test(
    "reports a running local stack in pretty and json modes",
    { timeout: STATUS_TEST_TIMEOUT_MS },
    async () => {
      project = await makeTempLegacyStackProject("sb-status-e2e-");
      const projectDir = project.dir;

      const init = await runSupabase(["init"], {
        entrypoint: "legacy",
        cwd: projectDir,
        exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS,
      });
      requireCliSuccess(init, "init setup");

      const start = await runSupabase(
        ["start", "--exclude", "studio", "--exclude", "logflare", "--exclude", "vector"],
        { entrypoint: "legacy", cwd: projectDir, exitTimeoutMs: STACK_START_TIMEOUT_MS },
      );
      requireCliSuccess(start, "start setup");

      const pretty = await runSupabase(["status"], {
        entrypoint: "legacy",
        cwd: projectDir,
        exitTimeoutMs: STATUS_COMMAND_TIMEOUT_MS,
      });
      expect(pretty.exitCode, `stdout:\n${pretty.stdout}\nstderr:\n${pretty.stderr}`).toBe(0);
      expect(`${pretty.stdout}${pretty.stderr}`).toContain("is running");
      expect(pretty.stdout).toContain("Project URL");
      expect(pretty.stdout).toContain("Database");

      const json = await runSupabase(["status", "-o", "json"], {
        entrypoint: "legacy",
        cwd: projectDir,
        exitTimeoutMs: STATUS_COMMAND_TIMEOUT_MS,
      });
      expect(json.exitCode, `stdout:\n${json.stdout}\nstderr:\n${json.stderr}`).toBe(0);
      const parsed: unknown = JSON.parse(json.stdout);
      expect(parsed).toMatchObject({
        API_URL: expect.stringContaining("http"),
        DB_URL: expect.stringContaining("postgresql://"),
      });
    },
  );
});
