import { expect, test } from "vitest";

test("live Vitest config loads its global setup when live mode is disabled", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--bun",
      "vitest",
      "run",
      "--config",
      "vitest.live.config.ts",
      "src/tests/live-config-setup.e2e.test.ts",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLI_E2E_MODE: "replay",
        CLI_E2E_TARGET_ENV: "staging",
        SUPABASE_ACCESS_TOKEN: "",
        SUPABASE_E2E_CLI_LIVE_STAGING_ACCESS_TOKEN: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  expect({
    exitCode: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  }).toEqual(expect.objectContaining({ exitCode: 0 }));
});
