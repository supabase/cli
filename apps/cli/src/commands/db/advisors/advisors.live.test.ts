import { BunServices } from "@effect/platform-bun";
import { randomUUID } from "node:crypto";

import { Cause, Effect, Exit, FileSystem, Option, Predicate, Schema } from "effect";
import { expect } from "vitest";

import { queryLiveDb, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";

/** What the lint's filters see for `public.<table>` on a connection as `dbUrl`'s role. */
const lintVisibility = (dbUrl: string, table: string) =>
  Effect.tryPromise(() =>
    queryLiveDb(
      dbUrl,
      `select current_user as role,
         current_setting('pgrst.db_schemas', true) as session_default_exposed_schemas,
         c.relrowsecurity as rls,
         has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
         has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = $1`,
      [table],
    ),
  ).pipe(
    Effect.map((rows) => `lint visibility of public.${table}: ${JSON.stringify(rows)}`),
    Effect.catch((cause) => Effect.succeed(`lint visibility query failed: ${String(cause)}`)),
  );

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

        const result = yield* cliEffect(["db", "advisors", `--remote=${project.dbUrl}`]);
        expect(result.exitCode, result.stderr).toBe(0);
        if (result.stdout === "") {
          const visibility = yield* lintVisibility(project.dbUrl, table);
          expect.fail(`${result.stderr}\n${visibility}`);
        }
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

test("reports public tables when the backend defaults exposed schemas to empty", ({
  cliEffect,
  project,
  signal,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const suffix = randomUUID().replaceAll("-", "");
      const role = `e2e_adv_${suffix}`;
      const table = `e2e_advisors_${suffix}`;
      const password = randomUUID();
      const dbUrl = new URL(project.dbUrl);
      dbUrl.username = `${role}.${project.ref}`;
      dbUrl.password = password;
      const target = Effect.gen(function* () {
        yield* Effect.promise(() =>
          queryLiveDb(project.dbUrl, `create role ${role} login password '${password}'`),
        );
        yield* Effect.promise(() =>
          queryLiveDb(project.dbUrl, `alter role ${role} set pgrst.db_schemas = ''`),
        );
        yield* Effect.promise(() =>
          queryLiveDb(project.dbUrl, `create table public.${table} (id int)`),
        );
        const exposure = yield* Effect.promise(() =>
          queryLiveDb(dbUrl.toString(), "select current_setting('pgrst.db_schemas', true) as v"),
        );
        expect(exposure).toEqual([{ v: "" }]);
        const result = yield* cliEffect(["db", "advisors", "--db-url", dbUrl.toString()]);
        expect(result.exitCode, result.stderr).toBe(0);
        if (result.stdout === "") {
          const visibility = yield* lintVisibility(dbUrl.toString(), table);
          expect.fail(`${result.stderr}\n${visibility}`);
        }
        const findings = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Array(Schema.Unknown)),
        )(result.stdout);
        expect(findings, result.stdout).toContainEqual(
          expect.objectContaining({
            name: "rls_disabled_in_public",
            metadata: expect.objectContaining({ schema: "public", name: table }),
          }),
        );
      }).pipe(Effect.withSpan("AdvisorsLive.emptyBackend"));
      const targetExit = yield* Effect.exit(target);
      const cleanupExits = [
        yield* Effect.exit(
          Effect.promise(() => queryLiveDb(project.dbUrl, `drop table if exists public.${table}`)),
        ),
        yield* Effect.exit(
          Effect.promise(() => queryLiveDb(project.dbUrl, `drop role if exists ${role}`)),
        ),
      ];
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors: cleanupExits.filter(Exit.isFailure).map((exit) => Cause.squash(exit.cause)),
      };
    }),
    { signal },
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));

test("reports tables in a configured non-public exposed schema", ({
  cliEffect,
  project,
  workspace,
  signal,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const schema = `e2e_adv_${randomUUID().replaceAll("-", "")}`;
      const table = "unprotected";
      const target = Effect.gen(function* () {
        yield* fs.writeFileString(
          `${workspace.path}/supabase/config.toml`,
          `[api]\nschemas = ["public", "${schema}"]\n`,
        );
        yield* Effect.promise(() => queryLiveDb(project.dbUrl, `create schema ${schema}`));
        yield* Effect.promise(() =>
          queryLiveDb(project.dbUrl, `create table ${schema}.${table} (id int)`),
        );
        yield* Effect.promise(() =>
          queryLiveDb(project.dbUrl, `grant usage on schema ${schema} to anon`),
        );
        yield* Effect.promise(() =>
          queryLiveDb(project.dbUrl, `grant select on table ${schema}.${table} to anon`),
        );
        const result = yield* cliEffect(["db", "advisors", "--db-url", project.dbUrl]);
        expect(result.exitCode, result.stderr).toBe(0);
        const findings = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Array(Schema.Unknown)),
        )(result.stdout);
        expect(findings, result.stdout).toContainEqual(
          expect.objectContaining({
            name: "rls_disabled_in_public",
            metadata: expect.objectContaining({ schema, name: table }),
          }),
        );
      }).pipe(Effect.withSpan("AdvisorsLive.nonPublicSchema"));
      const targetExit = yield* Effect.exit(target);
      const cleanupExit = yield* Effect.exit(
        Effect.promise(() => queryLiveDb(project.dbUrl, `drop schema if exists ${schema} cascade`)),
      );
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
      };
    }).pipe(Effect.provide(BunServices.layer)),
    { signal },
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
