import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { queryLiveDb, test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";

// A table in `public` without row level security deterministically raises the
// `rls_disabled_in_public` security lint.
test("reads advisor findings over the database connection", async ({ cli, project }) => {
  const table = `e2e_advisors_${randomUUID().slice(0, 8)}`;
  let targetError: unknown;
  const cleanupErrors: Array<unknown> = [];
  try {
    await queryLiveDb(project.dbUrl, `create table public.${table} (id int)`);

    const result = await cli(["db", "advisors", "--db-url", project.dbUrl]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout, result.stderr).not.toBe("");
    const findings = JSON.parse(result.stdout) as Array<{ name: string }>;
    const finding = findings.find(
      (candidate) =>
        candidate.name === "rls_disabled_in_public" && JSON.stringify(candidate).includes(table),
    );
    expect(finding, result.stdout).toBeDefined();
  } catch (error) {
    targetError = error;
  } finally {
    try {
      await queryLiveDb(project.dbUrl, `drop table if exists public.${table}`);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwWithCleanup(targetError, cleanupErrors);
});
