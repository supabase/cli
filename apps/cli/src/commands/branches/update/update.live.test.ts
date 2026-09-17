import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit, Schema } from "effect";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";
import { awaitBranch, removeBranch } from "../../../../tests/helpers/branches-live.ts";

const CreatedBranch = Schema.Struct({ project_ref: Schema.String });

// Not wired to the test `signal`: cleanup runs through the plain-promise `cli` path, so an
// interrupt would abandon an in-flight `branches delete` rather than stop it, leaving the
// branch behind. Its own exit timeout bounds the wait instead.
test("renames a preview branch", ({ cli, cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `cli-e2e-update-${randomUUID().slice(0, 8)}`;
      const renamed = `${name}-renamed`;
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

        // `--output json` keeps stdout payload-only and sends the confirmation to stderr.
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
        yield* awaitBranch(cli, project, renamed);
      });

      const targetExit = yield* Effect.exit(target);
      const cleanupExit = yield* Effect.exit(removeBranch(cli, project, branchRef ?? name));
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
      };
    }),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
