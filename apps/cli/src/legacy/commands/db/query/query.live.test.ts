import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { test } from "../../../../../tests/helpers/live.ts";

test("runs SQL against the remote database and returns its rows", async ({ cli, project }) => {
  const marker = `e2e_query_${randomUUID().slice(0, 8)}`;
  const result = await cli([
    "db",
    "query",
    `select '${marker}' as marker`,
    "--db-url",
    project.dbUrl,
    "-o",
    "json",
    "--agent",
    "no",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout, result.stderr).not.toBe("");
  expect(JSON.parse(result.stdout)).toEqual([{ marker }]);
});
