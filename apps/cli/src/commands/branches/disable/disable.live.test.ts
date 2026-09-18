import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit } from "effect";
import { expect } from "vitest";

import { throwWithCleanup, test } from "../../../../tests/helpers/live.ts";
import {
  awaitLiveBranchEffect,
  awaitLiveBranchRemovedEffect,
  awaitLiveBranchesRemovedEffect,
  createLiveBranchEffect,
} from "../../../../tests/helpers/branches-live.ts";

test("disables preview branching", ({ cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `cli-e2e-disable-${randomUUID().slice(0, 8)}`;
      let branchRef: string | undefined;
      let deletionAcknowledged = false;

      const target = Effect.gen(function* () {
        // The platform 422s `branches disable` while any non-default branch exists, so this
        // creates then deletes one first, waiting for it to fully disappear. Sibling tests
        // re-enable branching by creating their own branch first.
        const ref = yield* createLiveBranchEffect(cliEffect, project, name);
        branchRef = ref;
        yield* awaitLiveBranchEffect(cliEffect, project, name);
        const removed = yield* cliEffect([
          "branches",
          "delete",
          name,
          "--project-ref",
          project.ref,
          "--yes",
        ]);
        deletionAcknowledged = removed.exitCode === 0;
        expect(removed.exitCode, removed.stderr).toBe(0);
        yield* awaitLiveBranchRemovedEffect(cliEffect, project, ref, deletionAcknowledged);
        yield* awaitLiveBranchesRemovedEffect(cliEffect, project);
        branchRef = undefined;

        const disabled = yield* cliEffect(["branches", "disable", "--project-ref", project.ref]);
        expect(disabled.exitCode, disabled.stderr).toBe(0);
        expect(disabled.stdout).toContain(`Disabled preview branching for project: ${project.ref}`);
      });

      const targetExit = yield* Effect.exit(target);
      const cleanupExit =
        branchRef === undefined
          ? yield* Effect.exit(Effect.succeed(true))
          : yield* Effect.exit(
              awaitLiveBranchRemovedEffect(cliEffect, project, branchRef, deletionAcknowledged),
            );
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
      };
    }),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
