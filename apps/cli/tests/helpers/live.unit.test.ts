import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";

import { requireCliSuccess } from "./cli.ts";
import {
  type LiveFixtures,
  type LiveProject,
  resetLiveDatabase,
  throwWithCleanup,
} from "./live.ts";

const project: LiveProject = {
  ref: "abcdefghijklmnopqrst",
  dbUrl: "postgresql://postgres:password@example.com:5432/postgres",
  dbPassword: "password",
  anonKey: "anon",
  serviceRoleKey: "service-role",
  functionsUrl: "https://example.com/functions",
  storageBucket: "bucket",
};
const restarted = {
  exitCode: 1,
  stdout: "",
  stderr:
    "failed to connect to postgres: server error (FATAL: terminating connection due to administrator command (SQLSTATE 57P01))",
};
const refused = { exitCode: 1, stdout: "", stderr: "permission denied for schema public" };
const reset = { exitCode: 0, stdout: "", stderr: "Resetting remote database..." };

function scriptedCli(results: ReadonlyArray<typeof reset>) {
  const calls: string[] = [];
  const cliEffect: LiveFixtures["cliEffect"] = (args) =>
    Effect.sync(() => {
      calls.push(args.join(" "));
      return results[calls.length - 1] ?? reset;
    });
  return { calls, cliEffect };
}

describe("requireCliSuccess", () => {
  it("passes a zero exit through", () => {
    expect(() => requireCliSuccess({ exitCode: 0, stdout: "", stderr: "" }, "cmd")).not.toThrow();
  });

  it("reports a nonzero exit with the output attached", () => {
    expect(() => requireCliSuccess({ exitCode: 2, stdout: "out", stderr: "err" }, "cmd")).toThrow(
      /cmd failed \(exit 2\)\nstdout:\nout\nstderr:\nerr/u,
    );
  });

  it("names the harness exit bound when the subprocess was SIGKILLed", () => {
    expect(() =>
      requireCliSuccess({ exitCode: 1, stdout: "", stderr: "", timedOutAfterMs: 90_000 }, "cmd"),
    ).toThrow(/cmd failed \(exit 1; harness SIGKILLed it after 90000ms without exit\)/u);
  });
});

describe("throwWithCleanup", () => {
  it("rethrows the primary failure when cleanup succeeds", () => {
    const primary = new Error("target failed");

    expect(() => throwWithCleanup(primary, [])).toThrow(primary);
  });

  it("throws the cleanup failure when the target succeeds", () => {
    const cleanup = new Error("cleanup failed");

    expect(() => throwWithCleanup(undefined, [cleanup])).toThrow(cleanup);
  });

  it("preserves the primary and every cleanup failure", () => {
    const primary = new Error("target failed");
    const cleanup = [new Error("first cleanup failed"), new Error("second cleanup failed")];
    let thrown: unknown;

    try {
      throwWithCleanup(primary, cleanup);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) return;
    expect(thrown.errors).toEqual([primary, ...cleanup]);
  });
});

describe("resetLiveDatabase", () => {
  const failureOf = (cliEffect: LiveFixtures["cliEffect"]) =>
    Effect.exit(resetLiveDatabase(cliEffect, project, "db reset cleanup")).pipe(
      Effect.map((exit) => (Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : undefined)),
    );

  it.effect("re-issues the reset once when the platform restarted the database", () =>
    Effect.gen(function* () {
      const { calls, cliEffect } = scriptedCli([restarted, reset]);

      expect(yield* failureOf(cliEffect)).toBeUndefined();
      expect(calls).toEqual([
        `db reset --yes --remote=${project.dbUrl}`,
        `db reset --yes --remote=${project.dbUrl}`,
      ]);
    }),
  );

  it.effect("fails without re-issuing a reset that failed for another reason", () =>
    Effect.gen(function* () {
      const { calls, cliEffect } = scriptedCli([refused, reset]);

      expect(yield* failureOf(cliEffect)).toMatch(
        /db reset cleanup failed \(exit 1\)[\s\S]*permission denied/u,
      );
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("names the re-issue when the platform restarts the database twice", () =>
    Effect.gen(function* () {
      const { calls, cliEffect } = scriptedCli([restarted, restarted]);

      expect(yield* failureOf(cliEffect)).toMatch(
        /db reset cleanup re-issued after a platform database restart failed/u,
      );
      expect(calls).toHaveLength(2);
    }),
  );
});
