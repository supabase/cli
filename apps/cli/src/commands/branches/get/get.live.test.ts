import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit } from "effect";
import { expect } from "vitest";

import { throwWithCleanup, test } from "../../../../tests/helpers/live.ts";
import {
  awaitLiveBranchEffect,
  awaitLiveBranchRemovedEffect,
  createLiveBranchEffect,
} from "../../../../tests/helpers/branches-live.ts";

test("gets a preview branch by name", ({ cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `cli-e2e-get-${randomUUID().slice(0, 8)}`;
      let branchRef: string | undefined;

      const target = Effect.gen(function* () {
        const ref = yield* createLiveBranchEffect(cliEffect, project, name);
        branchRef = ref;
        yield* awaitLiveBranchEffect(cliEffect, project, name);
        const result = yield* cliEffect(["branches", "get", name, "--project-ref", project.ref]);
        expect(result.exitCode, result.stderr).toBe(0);
        // The pretty table prints the branch password and JWT secret, so failures
        // must not echo stdout: assert through booleans with a secret-free message.
        expect(
          /HOST.*STATUS/u.test(result.stdout),
          `branches get did not render the table header\nstderr:\n${result.stderr}`,
        ).toBe(true);
        expect(
          result.stdout.includes(ref),
          `branches get table has no cell containing branch ref ${ref}\nstderr:\n${result.stderr}`,
        ).toBe(true);
      });

      const targetExit = yield* Effect.exit(target);
      const cleanupExit =
        branchRef === undefined
          ? yield* Effect.exit(Effect.succeed(true))
          : yield* Effect.exit(awaitLiveBranchRemovedEffect(cliEffect, project, branchRef));
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
      };
    }),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
