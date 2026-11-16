import { randomUUID } from "node:crypto";

import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { test } from "../../../../tests/helpers/live.ts";

const decodeRows = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

test("runs SQL against the remote database and returns its rows", ({
  cliEffect,
  project,
  signal,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const marker = `e2e_query_${randomUUID().slice(0, 8)}`;
      const result = yield* cliEffect([
        "db",
        "query",
        `select '${marker}' as marker`,
        "--read-only",
        "-o",
        "json",
        "--agent",
        "no",
        `--remote=${project.dbUrl}`,
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout, result.stderr).not.toBe("");
      expect(yield* decodeRows(result.stdout)).toEqual([{ marker }]);
    }),
    { signal },
  ));

test("the database rejects a write that passes the keyword check under --read-only", ({
  cliEffect,
  project,
  signal,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const table = `e2e_query_ro_${randomUUID().slice(0, 8)}`;
      const result = yield* cliEffect([
        "db",
        "query",
        `select 1 as id into ${table}`,
        "--read-only",
        `--remote=${project.dbUrl}`,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("read-only transaction");
    }),
    { signal },
  ));
