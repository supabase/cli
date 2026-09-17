import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit, Schema } from "effect";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";
import { awaitBranch, removeBranch } from "../../../../tests/helpers/branches-live.ts";

const CreatedBranch = Schema.Struct({ project_ref: Schema.String });

// Not wired to the test `signal`: cleanup runs through the plain-promise `cli` path, so an
// interrupt would abandon an in-flight `branches delete` rather than stop it, leaving the
// branch behind. Its own exit timeout bounds the wait instead.
test("gets a preview branch by name", ({ cli, cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `cli-e2e-get-${randomUUID().slice(0, 8)}`;
      let branchRef: string | undefined;

      const target = Effect.gen(function* () {
        const created = yield* cliEffect([
          "branches",
          "create",
          name,
          "--project-ref",
          project.ref,
          "--output-format",
          "json",
        ]);
        requireLiveSuccess(created, "branches create");
        const ref = (yield* Schema.decodeEffect(Schema.fromJsonString(CreatedBranch))(
          created.stdout,
        )).project_ref;
        branchRef = ref;
        expect(ref, created.stdout).toBeTruthy();
        yield* awaitBranch(cli, project, name);

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
      const cleanupExit = yield* Effect.exit(removeBranch(cli, project, branchRef ?? name));
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
      };
    }),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
