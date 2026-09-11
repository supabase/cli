// oxlint-disable effecttsgo/async-function -- Promise-facade live reset uses createTestStack.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- docker availability probe for optional container cases.
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- native storage marker path.
import { join } from "node:path";
import { promisify } from "node:util";
import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { createTestStack, type TestStack } from "../testing.ts";
import type { StackRuntimePreference } from "./Runtime.ts";

const RESET_TIMEOUT_MS = 180_000;
const execFile = promisify(execFileCallback);
const MARKER_TABLE = "public.stack_reset_marker";

const dockerAvailable = (): boolean =>
  spawnSync("docker", ["info"], { encoding: "utf8" }).status === 0;

const query = async (url: string, statement: string): Promise<ReadonlyArray<object>> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* PgClient.PgClient;
        return yield* client.unsafe(statement);
      }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url), connectTimeout: "10 seconds" }))),
    ),
  );

const volumeWorkloadIds = async (stackId: string): Promise<ReadonlyArray<string>> => {
  const listed = await execFile("docker", [
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=com.supabase.stack.stackId=${stackId}`,
  ]);
  const ids = listed.stdout
    .trim()
    .split("\n")
    .filter((value) => value.length > 0);
  if (ids.length === 0) return [];
  const inspected = await execFile("docker", [
    "inspect",
    "--format",
    '{{index .Labels "com.supabase.stack.workloadId"}}',
    ...ids,
  ]);
  return inspected.stdout
    .trim()
    .split("\n")
    .filter((value) => value.length > 0);
};

const resetAndAssert = async (
  stack: TestStack,
  runtime: StackRuntimePreference,
): Promise<void> => {
  const before = await stack.status();
  const credentials = await stack.credentials();
  await query(credentials.database.url, `CREATE TABLE ${MARKER_TABLE} (id integer PRIMARY KEY)`);
  const storageMarker = join(stack.stateRoot, stack.id, "data", "storage", "keep.txt");
  if (runtime.kind === "native") {
    await mkdir(join(stack.stateRoot, stack.id, "data", "storage"), { recursive: true });
    await writeFile(storageMarker, "keep");
  }
  const volumesBefore =
    runtime.kind === "container" ? await volumeWorkloadIds(stack.id) : [];

  const after = await stack.resetDatabase();
  expect(after.id).toBe(stack.id);
  expect(after.endpoints).toEqual(before.endpoints);
  expect(after.lifecycle).toBe("running");
  const database = after.capabilities.find((capability) => capability.name === "database");
  expect(database?.state).toBe("ready");

  const leftover = await query(
    (await stack.credentials()).database.url,
    `SELECT to_regclass('${MARKER_TABLE}') AS name`,
  );
  expect(leftover).toEqual([{ name: null }]);

  if (runtime.kind === "native") {
    expect(await readFile(storageMarker, "utf8")).toBe("keep");
  } else {
    const volumesAfter = await volumeWorkloadIds(stack.id);
    expect(volumesAfter.filter((id) => id !== "database:database")).toEqual(
      volumesBefore.filter((id) => id !== "database:database"),
    );
  }
};

describe("resetDatabase", () => {
  it(
    "wipes native Postgres while keeping identity, ports, and storage data",
    async () => {
      await using stack = await createTestStack({
        runtime: { kind: "native" },
      });
      await resetAndAssert(stack, { kind: "native" });
    },
    RESET_TIMEOUT_MS,
  );

  it.skipIf(!dockerAvailable())(
    "wipes container Postgres while keeping identity, ports, and non-database volumes",
    async () => {
      await using stack = await createTestStack({
        runtime: { kind: "container", engine: "docker" },
      });
      await resetAndAssert(stack, { kind: "container", engine: "docker" });
    },
    RESET_TIMEOUT_MS,
  );
});
