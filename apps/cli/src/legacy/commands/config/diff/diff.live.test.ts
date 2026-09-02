import { type ConfigChangeClass, projectConfigMappingRows } from "@supabase/config/internal";
import { expect } from "vitest";

import { requireLiveSuccess, test } from "../../../../../tests/helpers/live.ts";

// Golden path only: the one thing mocks cannot prove is the real
// `GET /v2/projects/{ref}/config` response shape (the GoTrue-keyed auth
// record especially) decoding and classifying cleanly. Branch coverage lives
// in diff.integration.test.ts. The `workspace` fixture behind `cli` is a
// fresh `supabase init` project directory.
test("diffs a freshly-initialized config against the project", async ({ cli, project }) => {
  const result = await cli([
    "config",
    "diff",
    "--project-ref",
    project.ref,
    "--output-format",
    "json",
  ]);
  // Read-only success regardless of drift (no --exit-code passed).
  requireLiveSuccess(result, "config diff");
  expect(result.stderr).toContain(`Comparing against project ${project.ref} using base config`);
  const payload = JSON.parse(result.stdout) as {
    scope: { present: string[] };
    changes: Array<{ path: string[]; class: ConfigChangeClass }>;
  };
  expect(payload.scope.present).toContain("auth");
  const changes = payload.changes.map(({ path, class: kind }) => ({ path: path.join("."), kind }));
  const classified = changes.map((change) => `${change.path} [${change.kind}]`).join("\n");
  // A fresh project legitimately drifts from the init template (confirmations,
  // TOTP, site URL), so remote auth values must reach classification, while
  // the registry's declared baselines suppress the platform's own defaults.
  expect(
    changes.some((change) => change.path.startsWith("auth.") && change.kind !== "local_only"),
    classified,
  ).toBe(true);
  const baselines = projectConfigMappingRows
    .filter((row) => row.unconfiguredValue !== undefined || row.platformRendered === true)
    .map((row) => row.configPath.join("."));
  expect(
    changes.filter((change) => baselines.includes(change.path)),
    classified,
  ).toEqual([]);
});
