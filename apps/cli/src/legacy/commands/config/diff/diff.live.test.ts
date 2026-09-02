import { expect } from "vitest";

import { stripAnsi } from "../../../../../tests/helpers/ansi.ts";
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
  expect(result.stderr).toMatch(/^Comparison scope: [^(\n]*\bauth\b/mu);
  // A fresh project legitimately drifts from the init template (confirmations,
  // TOTP, site URL), but the registry's declared baselines must still suppress
  // the platform's unconfigured-state noise: "0s" sessions, platform-rendered
  // mailer subjects, disabled notification toggles.
  const stdout = stripAnsi(result.stdout);
  const authNoiseLines = stdout
    .split("\n")
    .filter((line) => /^auth\.(sessions|email\.(template|notification))\./u.test(line));
  expect(authNoiseLines, stdout).toEqual([]);
  // Read-only success regardless of drift (no --exit-code passed).
  requireLiveSuccess(result, "config diff");
});
