import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Redacted, Semaphore } from "effect";
import {
  DatabaseBootstrapError,
  type DatabaseSession,
  runDatabaseBootstrap,
} from "./DatabaseBootstrap.ts";

const ROLE_NAMES = [
  "postgres",
  "authenticator",
  "pgbouncer",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "supabase_replication_admin",
  "supabase_read_only_user",
] as const;

type SettingValue = string | number;
type BootstrapState = {
  readonly schemas: Set<string>;
  readonly schemaOwners: Map<string, string>;
  readonly passwords: Map<string, string>;
  readonly settings: Map<string, SettingValue>;
};

const makeSession = (options: { readonly failOnce?: "role" | "setting" } = {}) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const state: BootstrapState = {
      schemas: new Set(),
      schemaOwners: new Map(),
      passwords: new Map(),
      settings: new Map(),
    };
    const operations: string[] = [];
    let transactions = 0;
    let failed = false;

    const session: DatabaseSession = {
      execute: () => Effect.void,
      transaction: (use) =>
        lock.withPermit(
          Effect.gen(function* () {
            transactions += 1;
            const pending: BootstrapState = {
              schemas: new Set(state.schemas),
              schemaOwners: new Map(state.schemaOwners),
              passwords: new Map(state.passwords),
              settings: new Map(state.settings),
            };
            const shouldFail = (kind: typeof options.failOnce) => {
              if (options.failOnce !== kind || failed) return false;
              failed = true;
              return true;
            };
            const transaction = {
              execute: (statement: string) =>
                Effect.gen(function* () {
                  yield* Effect.sync(() => operations.push(statement));
                  if (statement.includes("CREATE SCHEMA IF NOT EXISTS _realtime;"))
                    yield* Effect.sync(() => pending.schemas.add("_realtime"));
                  if (statement.includes("ALTER SCHEMA _realtime OWNER TO postgres;"))
                    yield* Effect.sync(() => pending.schemaOwners.set("_realtime", "postgres"));
                }),
              setRolePassword: (role: string, password: Redacted.Redacted<string>) =>
                Effect.gen(function* () {
                  yield* Effect.sync(() => operations.push(`ALTER ROLE ${role} PASSWORD`));
                  if (shouldFail("role"))
                    return yield* new DatabaseBootstrapError({
                      message: "role failed secret-password",
                    });
                  yield* Effect.sync(() => pending.passwords.set(role, Redacted.value(password)));
                }),
              setDatabaseSetting: (setting: {
                readonly name: string;
                readonly value: Redacted.Redacted<string> | number;
              }) =>
                Effect.gen(function* () {
                  yield* Effect.sync(() =>
                    operations.push(`ALTER DATABASE postgres SET ${setting.name}`),
                  );
                  if (shouldFail("setting"))
                    return yield* new DatabaseBootstrapError({
                      message: "setting failed secret-jwt",
                    });
                  yield* Effect.sync(() =>
                    pending.settings.set(
                      setting.name,
                      typeof setting.value === "number"
                        ? setting.value
                        : Redacted.value(setting.value),
                    ),
                  );
                }),
            };
            yield* use(transaction);
            state.schemas.clear();
            pending.schemas.forEach((schema) => state.schemas.add(schema));
            state.schemaOwners.clear();
            pending.schemaOwners.forEach((owner, schema) => state.schemaOwners.set(schema, owner));
            state.passwords.clear();
            pending.passwords.forEach((password, role) => state.passwords.set(role, password));
            state.settings.clear();
            pending.settings.forEach((value, name) => state.settings.set(name, value));
          }),
        ),
    };
    return {
      session,
      state,
      operations,
      get transactions() {
        return transactions;
      },
    };
  });

const options = (password: string, jwtSecret: string, jwtExpiry = 3600) => ({
  databasePassword: Redacted.make(password),
  jwtSecret: Redacted.make(jwtSecret),
  jwtExpiry,
});

describe("database bootstrap", () => {
  it.live("reconciles the schema, login roles, and settings on every invocation", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSession();
      yield* runDatabaseBootstrap(runtime.session, options("password-a", "jwt-a"));
      runtime.state.schemaOwners.set("_realtime", "other");
      yield* runDatabaseBootstrap(runtime.session, options("password-b", "jwt-b", 7200));

      expect(runtime.state.schemas).toEqual(new Set(["_realtime"]));
      expect(runtime.state.schemaOwners).toEqual(new Map([["_realtime", "postgres"]]));
      expect([...runtime.state.passwords.entries()]).toEqual(
        ROLE_NAMES.map((role) => [role, "password-b"]),
      );
      expect(runtime.state.settings).toEqual(
        new Map<string, SettingValue>([
          ["app.settings.jwt_secret", "jwt-b"],
          ["app.settings.jwt_exp", 7200],
        ]),
      );
      expect(runtime.transactions).toBe(2);
      expect(runtime.operations[0]).toContain("pg_advisory_xact_lock");
      expect(runtime.operations.join(" ")).not.toContain("password-a");
      expect(runtime.operations.join(" ")).not.toContain("password-b");
      expect(runtime.operations.join(" ")).not.toContain("jwt-a");
      expect(runtime.operations.join(" ")).not.toContain("jwt-b");
    }),
  );

  it.live("rolls back every bootstrap change and can retry after a transaction failure", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSession({ failOnce: "role" });
      const first = yield* runDatabaseBootstrap(
        runtime.session,
        options("secret-password", "secret-jwt"),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(first)).toBe(true);
      if (Exit.isFailure(first)) expect(Cause.pretty(first.cause)).not.toContain("secret-password");
      expect(runtime.state.schemas).toEqual(new Set());
      expect(runtime.state.schemaOwners).toEqual(new Map());
      expect(runtime.state.passwords).toEqual(new Map());
      expect(runtime.state.settings).toEqual(new Map());

      yield* runDatabaseBootstrap(runtime.session, options("secret-password", "secret-jwt"));
      expect(runtime.state.schemas).toEqual(new Set(["_realtime"]));
      expect(runtime.state.schemaOwners).toEqual(new Map([["_realtime", "postgres"]]));
      expect(runtime.state.passwords.size).toBe(ROLE_NAMES.length);
      expect(runtime.state.settings.get("app.settings.jwt_secret")).toBe("secret-jwt");
    }),
  );

  it.live("maps setting failures without exposing JWT material", () =>
    Effect.gen(function* () {
      const runtime = yield* makeSession({ failOnce: "setting" });
      const result = yield* runDatabaseBootstrap(
        runtime.session,
        options("secret-password", "secret-jwt"),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).not.toContain("secret-password");
        expect(Cause.pretty(result.cause)).not.toContain("secret-jwt");
      }
      expect(runtime.state.schemas).toEqual(new Set());
      expect(runtime.state.schemaOwners).toEqual(new Map());
      expect(runtime.state.passwords).toEqual(new Map());
      expect(runtime.state.settings).toEqual(new Map());
    }),
  );
});
