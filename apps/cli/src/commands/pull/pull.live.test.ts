import { expect } from "vitest";

import { requireLiveSuccess, test } from "../../../tests/helpers/live.ts";

// Golden path only: the one thing mocks cannot prove is the real four-step
// orchestration (`config pull`, migration-history fetch, `db pull`'s
// shadow-db diff, `functions download`) actually reaching a live Management
// API and its provisioned project's data plane in one pass, against a fresh
// `supabase init` checkout (the `workspace` fixture behind `cli`). Branch
// coverage for dry-run/declined/partial-failure dispositions lives in
// pull.aggregate.unit.test.ts and any handler-level integration test.
test("pulls config, migration history, db schema, and functions from a fresh project", async ({
  cli,
  project,
}) => {
  const result = await cli([
    "pull",
    "--project-ref",
    project.ref,
    "--output-format",
    "json",
    "--yes",
  ]);
  requireLiveSuccess(result, "pull");

  const payload = JSON.parse(result.stdout);
  expect(payload).toEqual(
    expect.objectContaining({
      schema_version: 1,
      target: expect.objectContaining({ project_ref: project.ref }),
      steps: expect.objectContaining({
        config: expect.objectContaining({ status: expect.not.stringMatching(/^failed$/) }),
        migration_history: expect.objectContaining({
          status: expect.not.stringMatching(/^failed$/),
        }),
        db: expect.objectContaining({ status: expect.not.stringMatching(/^failed$/) }),
        functions: expect.objectContaining({ status: expect.not.stringMatching(/^failed$/) }),
      }),
    }),
  );
  expect(payload.counts.failed).toBe(0);
});
