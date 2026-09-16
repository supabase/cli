import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit, Schema } from "effect";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";
import { awaitBranch, removeBranch } from "../../../../tests/helpers/branches-live.ts";

const ListedBranches = Schema.Array(Schema.Struct({ name: Schema.optional(Schema.String) }));

// Not wired to the test `signal`: cleanup runs through the plain-promise `cli` path, so an
// interrupt would abandon an in-flight `branches delete` rather than stop it, leaving the
// branch behind. Its own exit timeout bounds the wait instead.
test("lists a preview branch for the project", ({ cli, cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `cli-e2e-list-${randomUUID().slice(0, 8)}`;

      const target = Effect.gen(function* () {
        const created = yield* cliEffect([
          "branches",
          "create",
          name,
          "--project-ref",
          project.ref,
        ]);
        requireLiveSuccess(created, "branches create setup");
        yield* awaitBranch(cli, project, name);

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
      const cleanupExit = yield* Effect.exit(removeBranch(cli, project, name));
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
      };
    }),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
