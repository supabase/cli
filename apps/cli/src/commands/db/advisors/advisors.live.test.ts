import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect";
import { expect } from "vitest";

import { queryLiveDb, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";

// A table in `public` without row level security deterministically raises the
// `rls_disabled_in_public` security lint.
test("reads advisor findings over the database connection", ({ cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const table = `e2e_advisors_${randomUUID().slice(0, 8)}`;

      const target = Effect.gen(function* () {
        yield* Effect.promise(() =>
          queryLiveDb(project.dbUrl, `create table public.${table} (id int)`),
        );

        const result = yield* cliEffect(["db", "advisors", "--db-url", project.dbUrl]);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout, result.stderr).not.toBe("");
        const findings = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Array(Schema.Unknown)),
        )(result.stdout);
        const finding = yield* Effect.findFirst(findings, (candidate) =>
          Predicate.hasProperty(candidate, "name") && candidate.name === "rls_disabled_in_public"
            ? Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(candidate).pipe(
                Effect.map((text) => text.includes(table)),
              )
            : Effect.succeed(false),
        );
        expect(Option.getOrUndefined(finding), result.stdout).toBeDefined();
      });

      const targetExit = yield* Effect.exit(target);
      const cleanupExit = yield* Effect.exit(
        Effect.promise(() => queryLiveDb(project.dbUrl, `drop table if exists public.${table}`)),
      );
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
      };
    }),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
