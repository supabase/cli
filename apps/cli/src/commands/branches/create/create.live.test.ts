import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit } from "effect";
import { expect } from "vitest";

import {
  awaitLiveBranch,
  removeLiveBranch,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("creates a preview branch", ({ cli, cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `cli-e2e-create-${randomUUID().slice(0, 8)}`;

      const target = Effect.gen(function* () {
        const result = yield* cliEffect(["branches", "create", name, "--project-ref", project.ref]);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout).toContain("Created preview branch");
        yield* Effect.promise(() => awaitLiveBranch(cli, project, name));
      });

      const targetExit = yield* Effect.exit(target);
      const cleanupExit = yield* Effect.exit(
        Effect.promise(() => removeLiveBranch(cli, project, name)),
      );
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
      };
    }),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
