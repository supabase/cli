import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  acquireDatabasePool,
  databasePoolStepDownVerify,
  needsRoleStepDown,
} from "./database-pool.ts";

describe("needsRoleStepDown", () => {
  it("steps down minted login roles and supabase_admin", () => {
    expect(needsRoleStepDown("cli_login_abc")).toBe(true);
    expect(needsRoleStepDown("cli_login_abc.txpqcjhbturcubdkrzoz")).toBe(true);
    expect(needsRoleStepDown("supabase_admin")).toBe(true);
    expect(needsRoleStepDown("SUPABASE_ADMIN")).toBe(true);
    expect(needsRoleStepDown("supabase_admin.ref")).toBe(true);
  });

  it("never re-asserts a role on sessions that did not step down", () => {
    expect(needsRoleStepDown("postgres")).toBe(false);
    expect(needsRoleStepDown("postgres.ref")).toBe(false);
    expect(needsRoleStepDown("repro_writer")).toBe(false);
  });
});

describe("databasePoolStepDownVerify", () => {
  it("runs SET SESSION ROLE postgres and reports success to the pool", async () => {
    const queries: Array<string> = [];
    const client = { query: (sql: string) => (queries.push(sql), Promise.resolve()) };
    const done = await new Promise<Error | undefined>((resolve) => {
      databasePoolStepDownVerify(client, resolve);
    });
    expect(queries).toEqual([
      "SET SESSION ROLE postgres",
      `SET search_path TO "$user", public, extensions`,
    ]);
    expect(done).toBeUndefined();
  });

  it("propagates a failing search_path restore after a successful step-down", async () => {
    const failure = new Error("cannot set search_path");
    const queries: Array<string> = [];
    const client = {
      query: (sql: string) => {
        queries.push(sql);
        return sql.includes("search_path") ? Promise.reject(failure) : Promise.resolve();
      },
    };
    const done = await new Promise<Error | undefined>((resolve) => {
      databasePoolStepDownVerify(client, resolve);
    });
    expect(queries).toEqual([
      "SET SESSION ROLE postgres",
      `SET search_path TO "$user", public, extensions`,
    ]);
    expect(done).toBe(failure);
  });

  it("propagates a failing step-down to the pool callback", async () => {
    const failure = new Error("permission denied to set role");
    const client = { query: () => Promise.reject(failure) };
    const done = await new Promise<Error | undefined>((resolve) => {
      databasePoolStepDownVerify(client, resolve);
    });
    expect(done).toBe(failure);
  });

  it("wraps a non-Error rejection into an Error for the pool callback", async () => {
    const client = { query: () => Promise.reject("boom") };
    const done = await new Promise<Error | undefined>((resolve) => {
      databasePoolStepDownVerify(client, resolve);
    });
    expect(done).toBeInstanceOf(Error);
    expect(String(done)).toContain("boom");
  });
});

describe("acquireDatabasePool", () => {
  it.effect("installs SET SESSION ROLE postgres on cli_login_* pools", () =>
    Effect.gen(function* () {
      const pool = yield* acquireDatabasePool(
        "postgresql://cli_login_abc.txpqcjhbturcubdkrzoz:secret@127.0.0.1:1/postgres",
      );
      expect(Reflect.get(pool.options, "verify")).toBe(databasePoolStepDownVerify);
    }).pipe(Effect.scoped),
  );

  it.effect("does not step down local postgres pools", () =>
    Effect.gen(function* () {
      const pool = yield* acquireDatabasePool(
        "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      );
      expect(Reflect.get(pool.options, "verify")).toBeUndefined();
    }).pipe(Effect.scoped),
  );
});
