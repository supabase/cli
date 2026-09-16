import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber } from "effect";
import * as TestClock from "effect/testing/TestClock";

import {
  awaitLiveBranchEffect,
  awaitLiveBranchListedEffect,
  awaitLiveBranchRemovedEffect,
  createLiveBranchEffect,
  type BranchCli,
} from "./branches-live.ts";
import type { LiveProject } from "./live.ts";

const project: LiveProject = {
  ref: "abcdefghijklmnopqrst",
  dbUrl: "postgresql://postgres:password@example.com:5432/postgres",
  dbPassword: "password",
  anonKey: "anon",
  serviceRoleKey: "service-role",
  functionsUrl: "https://example.com/functions",
  storageBucket: "bucket",
};
const branchRef = "zyxwvutsrqponmlkjihg";
const branch = { name: "feature-x", project_ref: branchRef, is_default: false };
const defaultBranch = { name: "main", project_ref: project.ref, is_default: true };

type State = {
  readonly calls: string[];
  listed: boolean;
  getReady: boolean;
  deleteAttempts: number;
};

function result(stdout = "", stderr = "", exitCode = 0) {
  return { stdout, stderr, exitCode };
}

function statefulCli(state: State): BranchCli {
  return (args) =>
    Effect.sync(() => {
      state.calls.push(args.join(" "));
      if (args[1] === "create") {
        return result(JSON.stringify({ ...branch, project_ref: branchRef }));
      }
      if (args[1] === "get") {
        return state.getReady
          ? result(JSON.stringify(branch))
          : result("", "Request failed with status 404", 1);
      }
      if (args[1] === "list") {
        return result(JSON.stringify(state.listed ? [defaultBranch, branch] : [defaultBranch]));
      }
      if (args[1] === "delete") {
        state.deleteAttempts += 1;
        if (state.deleteAttempts === 1) return result("", "Request failed with status 404", 1);
        state.listed = false;
        return result(JSON.stringify(branch));
      }
      return result("", "unexpected command", 1);
    });
}

describe("live branch lifecycle helpers", () => {
  it.effect("waits for LIST visibility after name lookup succeeds", () =>
    Effect.gen(function* () {
      const state: State = { calls: [], listed: false, getReady: true, deleteAttempts: 0 };
      const cli = statefulCli(state);
      const listed = yield* awaitLiveBranchListedEffect(cli, project, branch.name).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("2 seconds");
      state.listed = true;
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(listed);
      expect(state.calls.filter((call) => call.includes("branches list")).length).toBeGreaterThan(
        1,
      );
      expect(state.calls.some((call) => call.includes("branches get"))).toBe(false);
    }),
  );

  it.effect("does not treat early LIST absence as deletion after a DELETE 404", () =>
    Effect.gen(function* () {
      const state: State = { calls: [], listed: false, getReady: false, deleteAttempts: 0 };
      const cli = statefulCli(state);
      const ref = yield* createLiveBranchEffect(cli, project, branch.name);
      expect(ref).toBe(branchRef);
      const cleanup = yield* awaitLiveBranchRemovedEffect(cli, project, ref).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("2 seconds");
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(cleanup);
      expect(state.deleteAttempts).toBe(2);
      const firstDelete = state.calls.findIndex((call) => call.includes("branches delete"));
      const secondDelete = state.calls.findIndex(
        (call, index) => index > firstDelete && call.includes("branches delete"),
      );
      expect(
        state.calls.slice(firstDelete, secondDelete).some((call) => call.includes("branches list")),
      ).toBe(false);
      expect(state.calls.at(-1)).toContain("branches list");
      expect(state.listed).toBe(false);
    }),
  );

  it.effect("waits for LIST absence after deletion was acknowledged", () =>
    Effect.gen(function* () {
      const state: State = { calls: [], listed: true, getReady: true, deleteAttempts: 0 };
      const cli: BranchCli = (args) =>
        Effect.sync(() => {
          state.calls.push(args.join(" "));
          if (args[1] === "list") {
            if (state.calls.filter((call) => call.includes("branches list")).length > 1) {
              state.listed = false;
            }
            return result(JSON.stringify(state.listed ? [defaultBranch, branch] : [defaultBranch]));
          }
          return result();
        });
      const cleanup = yield* awaitLiveBranchRemovedEffect(cli, project, branchRef, true).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(cleanup);
      expect(state.listed).toBe(false);
    }),
  );

  it.effect("fails a cleanup authorization error without retrying", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const cli: BranchCli = () =>
        Effect.sync(() => {
          attempts += 1;
          return result("", "Request failed with status 403: not found", 1);
        });
      const exit = yield* Effect.exit(awaitLiveBranchRemovedEffect(cli, project, branchRef));
      if (!Exit.isFailure(exit)) throw new Error("expected cleanup authorization failure");
      expect(String(exit.cause)).toContain("status 403");
      expect(attempts).toBe(1);
    }),
  );

  it.effect("fails malformed LIST payloads instead of treating them as branch absence", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const cli: BranchCli = () =>
        Effect.sync(() => {
          attempts += 1;
          return result(JSON.stringify([{}]));
        });
      const exit = yield* Effect.exit(awaitLiveBranchListedEffect(cli, project, branch.name));
      if (!Exit.isFailure(exit)) throw new Error("expected malformed list failure");
      expect(String(exit.cause)).toContain("unexpected payload");
      expect(attempts).toBe(1);
    }),
  );

  it.effect("honors the readiness deadline", () =>
    Effect.gen(function* () {
      const state: State = { calls: [], listed: false, getReady: false, deleteAttempts: 0 };
      const waiting = yield* awaitLiveBranchEffect(statefulCli(state), project, branch.name).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("60 seconds");
      const exit = yield* Fiber.await(waiting);
      if (!Exit.isFailure(exit)) throw new Error("expected readiness timeout");
      expect(String(exit.cause)).toContain("timed out");
    }),
  );

  it.effect("cleans up an owned name when a successful create payload is malformed", () =>
    Effect.gen(function* () {
      const state: State = { calls: [], listed: true, getReady: false, deleteAttempts: 0 };
      const cli: BranchCli = (args) =>
        Effect.sync(() => {
          state.calls.push(args.join(" "));
          if (args[1] === "create")
            return result(JSON.stringify({ message: "Created preview branch" }));
          if (args[1] === "delete") {
            state.listed = false;
            return result();
          }
          if (args[1] === "list")
            return result(JSON.stringify(state.listed ? [defaultBranch, branch] : [defaultBranch]));
          return result();
        });
      const exit = yield* Effect.exit(createLiveBranchEffect(cli, project, branch.name));
      if (!Exit.isFailure(exit)) throw new Error("expected malformed create failure");
      expect(String(exit.cause)).toContain("unexpected payload");
      expect(state.calls.some((call) => call.includes(`branches delete ${branch.name}`))).toBe(
        true,
      );
      expect(state.listed).toBe(false);
    }),
  );

  it.effect("cleans up an owned name when create exits after starting", () =>
    Effect.gen(function* () {
      const state: State = { calls: [], listed: true, getReady: false, deleteAttempts: 0 };
      const cli: BranchCli = (args) =>
        Effect.sync(() => {
          state.calls.push(args.join(" "));
          if (args[1] === "create") return result("", "create failed", 1);
          if (args[1] === "delete") {
            state.listed = false;
            return result();
          }
          if (args[1] === "list")
            return result(JSON.stringify(state.listed ? [defaultBranch, branch] : [defaultBranch]));
          return result();
        });
      const exit = yield* Effect.exit(createLiveBranchEffect(cli, project, branch.name));
      if (!Exit.isFailure(exit)) throw new Error("expected create failure");
      expect(String(exit.cause)).toContain("create failed");
      expect(state.calls).toContain(
        `branches delete ${branch.name} --project-ref ${project.ref} --yes`,
      );
      expect(state.listed).toBe(false);
    }),
  );

  it.effect("cleans up an owned name when create invocation fails", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const cli: BranchCli = (args) => {
        calls.push(args.join(" "));
        if (args[1] === "create") return Effect.fail(new Error("invocation failed"));
        if (args[1] === "delete") return Effect.succeed(result());
        if (args[1] === "list") return Effect.succeed(result(JSON.stringify([defaultBranch])));
        return Effect.succeed(result());
      };
      const exit = yield* Effect.exit(createLiveBranchEffect(cli, project, branch.name));
      if (!Exit.isFailure(exit)) throw new Error("expected invocation failure");
      expect(String(exit.cause)).toContain("invocation failed");
      expect(calls.some((call) => call.startsWith(`branches delete ${branch.name}`))).toBe(true);
    }),
  );

  it.effect("preserves create and cleanup failures", () =>
    Effect.gen(function* () {
      const cli: BranchCli = (args) =>
        args[1] === "create"
          ? Effect.fail(new Error("create invocation failed"))
          : Effect.succeed(result("", "cleanup forbidden", 1));
      const exit = yield* Effect.exit(createLiveBranchEffect(cli, project, branch.name));
      if (!Exit.isFailure(exit)) throw new Error("expected aggregate failure");
      const failure = Cause.squash(exit.cause);
      if (!(failure instanceof AggregateError)) throw new Error("expected aggregate failure cause");
      expect(failure.message).toBe("Branch create and cleanup failed");
      const causes = failure.errors.map(String).join("\n");
      expect(causes).toContain("create invocation failed");
      expect(causes).toContain("cleanup forbidden");
    }),
  );

  it.effect("keeps conservative by-name cleanup bounded when create never appears", () =>
    Effect.gen(function* () {
      const cli: BranchCli = (args) =>
        args[1] === "create"
          ? Effect.fail(new Error("create invocation failed"))
          : args[1] === "delete"
            ? Effect.succeed(result("", "Request failed with status 404", 1))
            : Effect.succeed(result(JSON.stringify([defaultBranch])));
      const cleanup = yield* createLiveBranchEffect(cli, project, branch.name).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("120 seconds");
      const exit = yield* Fiber.await(cleanup);
      if (!Exit.isFailure(exit)) throw new Error("expected bounded cleanup failure");
      const failure = Cause.squash(exit.cause);
      if (!(failure instanceof AggregateError)) throw new Error("expected aggregate failure cause");
      const causes = failure.errors.map(String).join("\n");
      expect(causes).toContain("create invocation failed");
      expect(causes).toContain("branch removal feature-x timed out");
    }),
  );

  it.effect("uses one deadline across delayed deletion and LIST absence", () =>
    Effect.gen(function* () {
      const cli: BranchCli = (args) =>
        args[1] === "delete"
          ? Effect.sleep("60 seconds").pipe(Effect.as(result()))
          : Effect.succeed(result(JSON.stringify([defaultBranch, branch])));
      const waiting = yield* awaitLiveBranchRemovedEffect(cli, project, branchRef).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("120 seconds");
      const exit = yield* Fiber.await(waiting);
      if (!Exit.isFailure(exit)) throw new Error("expected removal timeout");
      expect(String(exit.cause)).toContain("timed out");
    }),
  );
});
