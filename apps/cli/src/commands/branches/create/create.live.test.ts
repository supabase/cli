import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit, Schema } from "effect";
import { expect } from "vitest";

import { throwWithCleanup, test } from "../../../../tests/helpers/live.ts";
import {
  awaitLiveBranchEffect,
  awaitLiveBranchRemovedEffect,
  removeLiveBranchByNameEffect,
} from "../../../../tests/helpers/branches-live.ts";

const CreatedBranchRef = Schema.Struct({ project_ref: Schema.String });
const CreatedBranch = Schema.Struct({ message: Schema.String, project_ref: Schema.String });

test("creates a preview branch", ({ cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `cli-e2e-create-${randomUUID().slice(0, 8)}`;
      let branchRef: string | undefined;

      const target = Effect.gen(function* () {
        const result = yield* cliEffect([
          "branches",
          "create",
          name,
          "--project-ref",
          project.ref,
          "--output-format",
          "json",
        ]);
        expect(result.exitCode, result.stderr).toBe(0);
        const refBody = yield* Schema.decodeEffect(Schema.fromJsonString(CreatedBranchRef))(
          result.stdout,
        );
        branchRef = refBody.project_ref.length > 0 ? refBody.project_ref : undefined;
        const body = yield* Schema.decodeEffect(Schema.fromJsonString(CreatedBranch))(
          result.stdout,
        );
        expect(body).toMatchObject({
          message: "Created preview branch",
          project_ref: expect.any(String),
        });
        expect(branchRef).toBeDefined();
        yield* awaitLiveBranchEffect(cliEffect, project, name);
      });

      const targetExit = yield* Effect.exit(target);
      const cleanupExit =
        branchRef === undefined
          ? yield* Effect.exit(removeLiveBranchByNameEffect(cliEffect, project, name))
          : yield* Effect.exit(awaitLiveBranchRemovedEffect(cliEffect, project, branchRef));
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
      };
    }),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
