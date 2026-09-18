import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit, Schema } from "effect";
import { expect } from "vitest";

import { throwWithCleanup, test } from "../../../../tests/helpers/live.ts";
import {
  awaitLiveBranchListedEffect,
  awaitLiveBranchRemovedEffect,
  createLiveBranchEffect,
} from "../../../../tests/helpers/branches-live.ts";

const ListedBranches = Schema.Array(Schema.Struct({ name: Schema.optional(Schema.String) }));

test("lists a preview branch for the project", ({ cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `cli-e2e-list-${randomUUID().slice(0, 8)}`;
      let branchRef: string | undefined;

      const target = Effect.gen(function* () {
        branchRef = yield* createLiveBranchEffect(cliEffect, project, name);
        yield* awaitLiveBranchListedEffect(cliEffect, project, name);
        const result = yield* cliEffect([
          "branches",
          "list",
          "--output",
          "json",
          "--project-ref",
          project.ref,
        ]);
        expect(result.exitCode, result.stderr).toBe(0);
        const branches = yield* Schema.decodeEffect(Schema.fromJsonString(ListedBranches))(
          result.stdout,
        );
        expect(branches.map((branch) => branch.name)).toContain(name);
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
