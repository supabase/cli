import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit } from "effect";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";
import { awaitBranch, removeBranch } from "../../../../tests/helpers/branches-live.ts";

// Not wired to the test `signal`: cleanup runs through the plain-promise `cli` path, so an
// interrupt would abandon an in-flight `branches delete` rather than stop it, leaving the
// branch behind. Its own exit timeout bounds the wait instead.
test("deletes a preview branch", ({ cli, cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `cli-e2e-delete-${randomUUID().slice(0, 8)}`;
      let mayExist = false;

      const target = Effect.gen(function* () {
        mayExist = true;
        const created = yield* cliEffect([
          "branches",
          "create",
          name,
          "--project-ref",
          project.ref,
        ]);
        requireLiveSuccess(created, "branches create");
        yield* awaitBranch(cli, project, name);

        const removed = yield* cliEffect([
          "branches",
          "delete",
          name,
          "--project-ref",
          project.ref,
          "--yes",
        ]);
        if (removed.exitCode === 0) mayExist = false;
        expect(removed.exitCode, removed.stderr).toBe(0);
        expect(removed.stderr).toContain("Deleted preview branch");
      });

      const targetExit = yield* Effect.exit(target);
      const cleanupExit = mayExist
        ? yield* Effect.exit(removeBranch(cli, project, name))
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
