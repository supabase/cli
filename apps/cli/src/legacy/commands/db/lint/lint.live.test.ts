import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { queryLiveDb, test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";

// A plpgsql function reading from a missing table is a deterministic schema
// error for `db lint` to report, independent of existing project state.
test("reports schema issues from the remote database", async ({ cli, project }) => {
  const name = `e2e_lint_${randomUUID().slice(0, 8)}`;
  let targetError: unknown;
  const cleanupErrors: Array<unknown> = [];
  try {
    await queryLiveDb(
      project.dbUrl,
      `create function public.${name}() returns void language plpgsql as $$ begin perform id from ${name}_missing; end $$`,
    );

    const result = await cli(["db", "lint", "--db-url", project.dbUrl]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout, result.stderr).not.toBe("");
    const results = JSON.parse(result.stdout) as Array<{ function: string }>;
    const entry = results.find((candidate) => candidate.function === `public.${name}`);
    expect(entry, result.stdout).toBeDefined();
    expect(JSON.stringify(entry)).toContain(`${name}_missing`);
  } catch (error) {
    targetError = error;
  } finally {
    try {
      await queryLiveDb(project.dbUrl, `drop function if exists public.${name}()`);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwWithCleanup(targetError, cleanupErrors);
});
