import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit, Schema } from "effect";
import { expect } from "vitest";

import { throwWithCleanup, test } from "../../../../tests/helpers/live.ts";
import {
  awaitLiveBranchEffect,
  awaitLiveBranchRemovedEffect,
  createLiveBranchEffect,
} from "../../../../tests/helpers/branches-live.ts";

test("renames a preview branch", ({ cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `cli-e2e-update-${randomUUID().slice(0, 8)}`;
      const renamed = `${name}-renamed`;
      let branchRef: string | undefined;

      const target = Effect.gen(function* () {
        branchRef = yield* createLiveBranchEffect(cliEffect, project, name);
        yield* awaitLiveBranchEffect(cliEffect, project, name);
        const updated = yield* cliEffect([
          "branches",
          "update",
          name,
          "--project-ref",
          project.ref,
          "--name",
          renamed,
          "--output",
          "json",
        ]);
        expect(updated.exitCode, updated.stderr).toBe(0);
        expect(updated.stderr).toContain("Updated preview branch");
        const payload = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          updated.stdout,
        );
        expect(payload).toMatchObject({ name: renamed });
        yield* awaitLiveBranchEffect(cliEffect, project, renamed);
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
