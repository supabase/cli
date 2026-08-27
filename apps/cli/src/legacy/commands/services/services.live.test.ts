import { expect } from "vitest";

import { requireLiveSuccess, test } from "../../../../tests/helpers/live.ts";

test("merges remote versions from the linked live project into table and json output", async ({
  cli,
  project,
}) => {
  const linked = await cli(["link", "--project-ref", project.ref, "--skip-pooler"]);
  requireLiveSuccess(linked, "link setup for services");

  const json = await cli(["services", "-o", "json"]);
  expect(json.exitCode, json.stderr).toBe(0);
  const rows = JSON.parse(json.stdout) as Array<{ name: string; local: string; remote: string }>;
  expect(rows, json.stdout).toHaveLength(10);
  const postgres = rows.find((row) => row.name === "supabase/postgres");
  if (postgres === undefined) {
    throw new Error(`supabase/postgres row missing from services json:\n${json.stdout}`);
  }
  expect(postgres.remote.length, json.stdout).toBeGreaterThan(0);

  const table = await cli(["services"]);
  expect(table.exitCode, table.stderr).toBe(0);
  const postgresRow = table.stdout
    .split("\n")
    .find((line) => line.split("|")[0]?.trim() === "supabase/postgres");
  if (postgresRow === undefined) {
    throw new Error(`supabase/postgres row missing from services table:\n${table.stdout}`);
  }
  expect(postgresRow.split("|")[2]?.trim(), table.stdout).toBe(postgres.remote);
});
