import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit } from "effect";
import { expect } from "vitest";

import { throwWithCleanup, test } from "../../../../tests/helpers/live.ts";
import {
  awaitLiveBranchEffect,
  awaitLiveBranchRemovedEffect,
  createLiveBranchEffect,
} from "../../../../tests/helpers/branches-live.ts";

test("deletes a preview branch", ({ cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `cli-e2e-delete-${randomUUID().slice(0, 8)}`;
      let branchRef: string | undefined;
      let deletionAcknowledged = false;

      const target = Effect.gen(function* () {
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
        expect(removed.stderr).toContain("Deleted preview branch");
        yield* awaitLiveBranchRemovedEffect(cliEffect, project, ref, deletionAcknowledged);
        branchRef = undefined;
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
