import { expect } from "vitest";

import { requireLiveSuccess, test } from "../../../../../tests/helpers/live.ts";

// Golden path only: the one thing mocks cannot prove is the real
// `GET /v2/projects/{ref}/config` response shape (the GoTrue-keyed auth
// record especially) decoding and classifying cleanly. Branch coverage lives
// in diff.integration.test.ts. The `workspace` fixture behind `cli` is a
// fresh `supabase init` project directory.
test("diffs a freshly-initialized config against the project", async ({ cli, project }) => {
  const result = await cli(["config", "diff", "--project-ref", project.ref]);
  expect(`${result.stdout}${result.stderr}`).not.toContain("Unauthorized");
  expect(result.stderr).toContain(`Comparing against project ${project.ref} using base config`);
  expect(result.stderr).toContain("Comparison scope:");
  // The GoTrue-keyed auth record — the one surface mocks cannot prove — must
  // classify CLEANLY against a fresh config: the platform's reports of
  // unconfigured state (session zeros canonicalized to "0s", the
  // provisioning-default mailer subjects, disabled notification toggles) are
  // suppressed by the registry's unconfiguredValue baselines, not flagged as
  // drift. Asserting only exit 0 here would let that noise through silently.
  const authChangeLines = result.stdout.split("\n").filter((line) => line.startsWith("auth."));
  expect(authChangeLines, result.stdout).toEqual([]);
  // Read-only success regardless of drift (no --exit-code passed).
  requireLiveSuccess(result, "config diff");
});
