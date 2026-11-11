import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { Effect, Schema, Stream } from "effect";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { describe, expect, test } from "vitest";

// The scheduled API sync only rewrites this package, and the project-config mirror lives in
// @supabase/config, so apps/cli's type-level drift guards only run on a PR touching either if turbo
// folds that package's files into the dependent's cached `types:check` hash via `transit`.

const repoDir = fileURLToPath(new URL("../../..", import.meta.url));
const turboBin = fileURLToPath(new URL("../../../node_modules/.bin/turbo", import.meta.url));

type DryRunTask = { readonly taskId: string; readonly dependencies: ReadonlyArray<string> };
const DryRunJson = Schema.fromJsonString(
  Schema.Struct({
    tasks: Schema.Array(
      Schema.Struct({ taskId: Schema.String, dependencies: Schema.Array(Schema.String) }),
    ),
  }),
);

const dryRunTypesCheckForDependents = (packageName: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        turboBin,
        ["run", "types:check", `--filter=...${packageName}`, "--dry=json"],
        {
          cwd: repoDir,
          stdin: "ignore",
        },
      ),
    );
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        handle.exitCode,
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* Effect.die(`turbo dry run exited with code ${exitCode}: ${stderr}`);
    }
    const { tasks } = yield* Schema.decodeEffect(DryRunJson)(stdout);
    return tasks;
  }).pipe(Effect.scoped);

function reachableTaskIds(tasks: ReadonlyArray<DryRunTask>, from: string): ReadonlySet<string> {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const seen = new Set<string>();
  const pending = [from];
  while (pending.length > 0) {
    const taskId = pending.pop();
    if (taskId === undefined || seen.has(taskId)) continue;
    seen.add(taskId);
    pending.push(...(byId.get(taskId)?.dependencies ?? []));
  }
  return seen;
}

describe("dependent types:check cache key", () => {
  test.each(["@supabase/api", "@supabase/config"])(
    "includes %s's files for every workspace that depends on it",
    (packageName) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const tasks = yield* dryRunTypesCheckForDependents(packageName);
          const dependentTypesChecks = tasks
            .map((task) => task.taskId)
            .filter(
              (taskId) => taskId.endsWith("#types:check") && !taskId.startsWith(`${packageName}#`),
            );

          expect(dependentTypesChecks).toContain("supabase#types:check");
          for (const taskId of dependentTypesChecks) {
            expect(reachableTaskIds(tasks, taskId), taskId).toContain(`${packageName}#transit`);
          }
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    60_000,
  );
});
