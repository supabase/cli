import { expect } from "vitest";

import { requireLiveSuccess, test } from "../../../../tests/helpers/live.ts";

test("merges remote versions from the linked live project into services output", async ({
  cli,
  project,
}) => {
  const linked = await cli(["link", "--project-ref", project.ref, "--skip-pooler"]);
  requireLiveSuccess(linked, "link setup for services");

  // One remote-backed invocation is the live golden path; cross-format
  // rendering is integration-tested with fixed remote data.
  const json = await cli(["services", "-o", "json"]);
  expect(json.exitCode, json.stderr).toBe(0);
  const rows = JSON.parse(json.stdout) as Array<{ name: string; local: string; remote: string }>;
  expect(rows, json.stdout).toHaveLength(10);
  const postgres = rows.find((row) => row.name === "supabase/postgres");
  if (postgres === undefined) {
    throw new Error(`supabase/postgres row missing from services json:\n${json.stdout}`);
  }
  expect(postgres.remote.length, json.stdout).toBeGreaterThan(0);
});
