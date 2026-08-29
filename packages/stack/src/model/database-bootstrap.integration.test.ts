import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Redacted, Semaphore } from "effect";
import {
  DatabaseBootstrapError,
  type DatabaseBootstrapSetting,
  type DatabaseBootstrapCredentials,
  type DatabaseSession,
  runDatabaseBootstrap,
} from "./DatabaseBootstrap.ts";

const revisions = [
  { id: "roles", statement: "CREATE ROLE anon" },
  { id: "extensions", statement: "CREATE EXTENSION pgcrypto" },
  { id: "schemas", statement: "CREATE SCHEMA extensions" },
] as const;

const makeSession = (
  options: { readonly failRevision?: string; readonly failPassword?: boolean } = {},
) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    let failed = false;
    const applied: string[] = [];
    const operations: string[] = [];
    const successfulRevisions: string[] = [];
    const passwords: Array<[string, string]> = [];
    const settings: Array<[string, string | number]> = [];
    const session: DatabaseSession = {
      execute: (statement) =>
        Effect.sync(() => {
          operations.push(statement.trim().split("\n")[0] ?? "");
        }),
      transaction: (use) =>
        lock.withPermit(
          Effect.gen(function* () {
            const pending: string[] = [];
            const tx = {
              execute: (
                statement: string,
                parameters?: ReadonlyArray<string | number | boolean | null>,
              ) =>
                Effect.gen(function* () {
                  operations.push(statement.trim().split("\n")[0] ?? "");
                  const id = parameters?.[0];
                  if (typeof id === "string" && statement.includes("INSERT")) pending.push(id);
                  const revision = revisions.find((entry) =>
                    statement.includes(entry.statement.trim().split("\n")[0] ?? ""),
                  );
                  if (revision !== undefined && revision.id === options.failRevision && !failed) {
                    failed = true;
                    return yield* new DatabaseBootstrapError({
                      message: `failed ${revision.id}`,
                      revision: revision.id,
                    });
                  }
                  if (revision !== undefined) successfulRevisions.push(revision.id);
                }),
              setRolePassword: (
                role:
                  | "postgres"
                  | "authenticator"
                  | "pgbouncer"
                  | "supabase_auth_admin"
                  | "supabase_storage_admin"
                  | "supabase_replication_admin"
                  | "supabase_read_only_user",
                password: Redacted.Redacted<string>,
              ) =>
                options.failPassword
                  ? Effect.fail(
                      new DatabaseBootstrapError({ message: "password rejected secret-password" }),
                    )
                  : Effect.sync(() => passwords.push([role, Redacted.value(password)])),
              setDatabaseSetting: (setting: DatabaseBootstrapSetting) =>
                Effect.sync(() => {
                  settings.push([
                    setting.name,
                    setting.name === "app.settings.jwt_secret"
                      ? Redacted.value(setting.value)
                      : setting.value,
                  ]);
                }),
              query: () => Effect.succeed(applied.map((revision) => ({ revision }))),
            };
            yield* use(tx);
            applied.push(...pending);
          }),
        ),
    };
    return { session, applied, operations, passwords, settings, successfulRevisions };
  });

describe("database bootstrap", () => {
  it.live("applies ordered revisions once and keeps credentials outside SQL", () =>
    Effect.gen(function* () {
      const state = yield* makeSession();
      const credentials: DatabaseBootstrapCredentials = {
        roles: { postgres: Redacted.make("secret-password") },
      };
      yield* runDatabaseBootstrap(state.session, {
        revisions,
        credentials,
        settings: { jwtSecret: Redacted.make("secret-jwt"), jwtExpiry: 3600 },
      });
      yield* runDatabaseBootstrap(state.session, {
        revisions,
        credentials,
        settings: { jwtSecret: Redacted.make("secret-jwt"), jwtExpiry: 3600 },
      });
      expect(state.applied).toEqual(revisions.map(({ id }) => id));
      // Credential reconciliation is intentionally a separate idempotent
      // phase. It runs on each invocation so a changed managed password is
      // applied even when every schema revision is already recorded.
      expect(state.passwords).toEqual([
        ["postgres", "secret-password"],
        ["postgres", "secret-password"],
      ]);
      expect(state.settings).toEqual([
        ["app.settings.jwt_secret", "secret-jwt"],
        ["app.settings.jwt_exp", 3600],
        ["app.settings.jwt_secret", "secret-jwt"],
        ["app.settings.jwt_exp", 3600],
      ]);
      expect(state.operations.join(" ")).not.toContain("secret-password");
    }),
  );

  it.live("does not record a failed revision and retries it later", () =>
    Effect.gen(function* () {
      const state = yield* makeSession({ failRevision: "schemas" });
      const first = yield* runDatabaseBootstrap(state.session, {
        revisions,
      }).pipe(Effect.exit);
      expect(Exit.isFailure(first)).toBe(true);
      expect(state.applied).toEqual(["roles", "extensions"]);
      yield* runDatabaseBootstrap(state.session, { revisions });
      expect(state.applied).toEqual(revisions.map(({ id }) => id));
      expect(state.successfulRevisions.filter((entry) => entry === "schemas")).toHaveLength(1);
    }),
  );

  it.live("keeps managed passwords out of SQL and bootstrap errors", () =>
    Effect.gen(function* () {
      const state = yield* makeSession({ failPassword: true });
      const result = yield* runDatabaseBootstrap(state.session, {
        revisions: [],
        credentials: { roles: { postgres: Redacted.make("secret-password") } },
      }).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.pretty(result.cause)).not.toContain("secret-password");
      expect(state.operations.join(" ")).not.toContain("secret-password");
    }),
  );

  it.live("applies the managed password to every login role", () =>
    Effect.gen(function* () {
      const state = yield* makeSession();
      const password = Redacted.make("secret-password");
      yield* runDatabaseBootstrap(state.session, {
        revisions: [],
        credentials: {
          roles: {
            postgres: password,
            authenticator: password,
            pgbouncer: password,
            supabase_auth_admin: password,
            supabase_storage_admin: password,
            supabase_replication_admin: password,
            supabase_read_only_user: password,
          },
        },
        settings: { jwtSecret: Redacted.make("secret-jwt"), jwtExpiry: 3600 },
      });
      expect(state.passwords).toEqual([
        ["postgres", "secret-password"],
        ["authenticator", "secret-password"],
        ["pgbouncer", "secret-password"],
        ["supabase_auth_admin", "secret-password"],
        ["supabase_storage_admin", "secret-password"],
        ["supabase_replication_admin", "secret-password"],
        ["supabase_read_only_user", "secret-password"],
      ]);
      expect(state.operations.join(" ")).not.toContain("secret-password");
    }),
  );

  it.live("serializes concurrent callers before applying a revision", () =>
    Effect.gen(function* () {
      const state = yield* makeSession();
      yield* Effect.all(
        [
          runDatabaseBootstrap(state.session, { revisions }),
          runDatabaseBootstrap(state.session, { revisions }),
        ],
        { concurrency: "unbounded", discard: true },
      );
      expect(state.applied).toEqual(revisions.map(({ id }) => id));
      expect(state.operations.filter((entry) => entry === "CREATE ROLE anon")).toHaveLength(1);
    }),
  );
});
