import { expect } from "vitest";

import { requireLiveSuccess, test } from "../../../../../tests/helpers/live.ts";

// Golden path only: the one thing mocks cannot prove is a real
// `GET /v2/projects/{ref}/config` response decoding, planning, and writing
// cleanly against a real (freshly-initialized) `supabase/config.toml`, and
// that a second run against the SAME project converges to nothing (the
// convergence check's own real-world counterpart — branch coverage lives in
// pull.integration.test.ts). The `workspace` fixture behind `cli` is a fresh
// `supabase init` project directory.
test("pulls remote config into a fresh project, converging to nothing on a second run", async ({
  cli,
  project,
}) => {
  const first = await cli(["config", "pull", "--project-ref", project.ref, "--yes"]);
  expect(`${first.stdout}${first.stderr}`).not.toContain("Unauthorized");
  requireLiveSuccess(first, "config pull");

  const second = await cli(["config", "pull", "--project-ref", project.ref, "--yes"]);
  requireLiveSuccess(second, "config pull");
  expect(second.stdout).toContain("No config differences found.");
});
