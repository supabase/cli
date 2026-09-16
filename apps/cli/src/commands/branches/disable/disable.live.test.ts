import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit } from "effect";
import { expect } from "vitest";

import {
  awaitLiveBranch,
  awaitLiveBranchesRemoved,
  removeLiveBranch,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("disables preview branching", ({ cli, cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `cli-e2e-disable-${randomUUID().slice(0, 8)}`;
      let mayExist = false;

      const target = Effect.gen(function* () {
        // The platform 422s `branches disable` while any non-default branch exists, so this
        // creates then deletes one first, waiting for it to fully disappear. Sibling tests
        // re-enable branching by creating their own branch first.
        mayExist = true;
        const created = yield* cliEffect([
          "branches",
          "create",
          name,
          "--project-ref",
          project.ref,
        ]);
        requireLiveSuccess(created, "branches create");
        yield* Effect.promise(() => awaitLiveBranch(cli, project, name));

        const removed = yield* cliEffect([
          "branches",
          "delete",
          name,
          "--project-ref",
          project.ref,
          "--yes",
        ]);
        if (removed.exitCode === 0) mayExist = false;
        requireLiveSuccess(removed, "branches delete");
        yield* Effect.promise(() => awaitLiveBranchesRemoved(cli, project));

        const disabled = yield* cliEffect(["branches", "disable", "--project-ref", project.ref]);
        expect(disabled.exitCode, disabled.stderr).toBe(0);
        expect(disabled.stdout).toContain(`Disabled preview branching for project: ${project.ref}`);
      });

      const targetExit = yield* Effect.exit(target);
      const cleanupExit = mayExist
        ? yield* Effect.exit(Effect.promise(() => removeLiveBranch(cli, project, name)))
        : undefined;
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors:
          cleanupExit !== undefined && Exit.isFailure(cleanupExit)
            ? [Cause.squash(cleanupExit.cause)]
            : [],
      };
    }),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
