import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit, Predicate, Schema } from "effect";
import { expect } from "vitest";

import { queryLiveDb, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";

// A plpgsql function reading from a missing table is a deterministic schema
// error for `db lint` to report, independent of existing project state.
test("reports schema issues from the remote database", ({ cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `e2e_lint_${randomUUID().slice(0, 8)}`;

      const target = Effect.gen(function* () {
        yield* Effect.promise(() =>
          queryLiveDb(
            project.dbUrl,
            `create function public.${name}() returns void language plpgsql as $$ begin perform id from ${name}_missing; end $$`,
          ),
        );

        const result = yield* cliEffect(["db", "lint", "--db-url", project.dbUrl]);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout, result.stderr).not.toBe("");
        const results = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Array(Schema.Unknown)),
        )(result.stdout);
        const entry = results.find(
          (candidate) =>
            Predicate.hasProperty(candidate, "function") && candidate.function === `public.${name}`,
        );
        expect(entry, result.stdout).toBeDefined();
        expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(entry)).toContain(
          `${name}_missing`,
        );
      });

      const targetExit = yield* Effect.exit(target);
      const cleanupExit = yield* Effect.exit(
        Effect.promise(() =>
          queryLiveDb(project.dbUrl, `drop function if exists public.${name}()`),
        ),
      );
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
      };
    }),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
