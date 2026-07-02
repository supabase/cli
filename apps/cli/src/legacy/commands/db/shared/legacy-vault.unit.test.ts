import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import type { LegacyDbSession } from "../../../shared/legacy-db-connection.service.ts";
import {
  legacyReadVaultDocument,
  legacySyncableVaultSecrets,
  legacyUpsertVaultSecrets,
} from "./legacy-vault.ts";

class FakeExecError extends Data.TaggedError("LegacyDbExecError")<{ readonly message: string }> {}

// Go's dotenvx test vector (`apps/cli-go/pkg/config/secret_test.go`): this key
// decrypts ENCRYPTED_VALUE to the plaintext "value".
const DOTENV_PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
const ENCRYPTED_VALUE =
  "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";

function fakeVaultSession(opts: { failOn?: string } = {}) {
  const calls: Array<{ kind: "exec" | "query"; sql: string; params?: ReadonlyArray<unknown> }> = [];
  const session: LegacyDbSession = {
    exec: (sql) => {
      calls.push({ kind: "exec", sql });
      return Effect.void;
    },
    query: (sql, params) => {
      calls.push({ kind: "query", sql, params });
      return opts.failOn !== undefined && sql.includes(opts.failOn)
        ? Effect.fail(new FakeExecError({ message: "boom" }))
        : Effect.succeed([] as ReadonlyArray<Record<string, unknown>>);
    },
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, calls };
}

describe("legacyReadVaultDocument", () => {
  it("returns undefined when the document or db.vault is absent", () => {
    expect(legacyReadVaultDocument(undefined)).toBeUndefined();
    expect(legacyReadVaultDocument({})).toBeUndefined();
    expect(legacyReadVaultDocument({ db: 5 })).toBeUndefined();
    expect(legacyReadVaultDocument({ db: { vault: "nope" } })).toBeUndefined();
  });

  it("keeps only string-valued entries", () => {
    expect(legacyReadVaultDocument({ db: { vault: { a: "x", b: 1, c: "y" } } })).toEqual({
      a: "x",
      c: "y",
    });
  });
});

describe("legacySyncableVaultSecrets", () => {
  it("returns nothing for an absent table", () => {
    expect(legacySyncableVaultSecrets(undefined)).toEqual([]);
  });

  it("skips empty + env-reference values but keeps encrypted candidates (decrypted later)", () => {
    const result = legacySyncableVaultSecrets({
      empty: "",
      fromEnv: "env(MY_SECRET)",
      encrypted: "encrypted:abc",
      literal: "plain-value",
    });
    // `encrypted:` values are syncable candidates — the raw ciphertext is decrypted
    // in legacyUpsertVaultSecrets (Go decrypts during config load then syncs plaintext).
    expect(result).toEqual([
      { key: "encrypted", value: "encrypted:abc" },
      { key: "literal", value: "plain-value" },
    ]);
  });

  it("skips any env(...) reference regardless of inner casing (Go's broad envPattern)", () => {
    // Go's `^env\((.*)\)$` matches any inner name, so a lowercase/odd reference is
    // left verbatim and never synced — it must NOT be treated as a literal value.
    const result = legacySyncableVaultSecrets({
      lower: "env(foo)",
      mixed: "env(My_Secret)",
      empty: "env()",
      dotted: "env(foo.bar)",
      literal: "plain-value",
    });
    expect(result).toEqual([{ key: "literal", value: "plain-value" }]);
  });
});

describe("legacyUpsertVaultSecrets", () => {
  const run = (session: LegacyDbSession, vault: Record<string, string>) =>
    legacyUpsertVaultSecrets(session, vault, (m) => new FakeExecError({ message: m })).pipe(
      Effect.provide(mockOutput({ format: "text" }).layer),
    );

  it.effect("wraps the create/update writes in a single transaction", () => {
    const { session, calls } = fakeVaultSession();
    return run(session, { a: "one", b: "two" }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const execs = calls.filter((c) => c.kind === "exec").map((c) => c.sql);
          expect(execs).toContain("BEGIN");
          expect(execs).toContain("COMMIT");
          // Both secrets created inside the transaction (no pre-existing rows).
          expect(calls.filter((c) => c.sql.includes("create_secret")).length).toBe(2);
        }),
      ),
    );
  });

  it.effect("rolls back so a mid-write failure leaves Vault unchanged", () => {
    const { session, calls } = fakeVaultSession({ failOn: "create_secret" });
    return run(session, { a: "one", b: "two" }).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          const execs = calls.filter((c) => c.kind === "exec").map((c) => c.sql);
          expect(execs).toContain("BEGIN");
          expect(execs).toContain("ROLLBACK");
          expect(execs).not.toContain("COMMIT");
        }),
      ),
    );
  });

  it.effect("decrypts an encrypted: secret and upserts the plaintext", () => {
    const prev = process.env["DOTENV_PRIVATE_KEY"];
    process.env["DOTENV_PRIVATE_KEY"] = DOTENV_PRIVATE_KEY;
    const { session, calls } = fakeVaultSession();
    return run(session, { my_secret: ENCRYPTED_VALUE }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const create = calls.find((c) => c.sql.includes("create_secret"));
          // Go decrypts during config load and syncs the plaintext (not the ciphertext).
          expect(create?.params).toEqual(["value", "my_secret"]);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["DOTENV_PRIVATE_KEY"];
          else process.env["DOTENV_PRIVATE_KEY"] = prev;
        }),
      ),
    );
  });

  it.effect("fails (before touching the DB) when an encrypted: secret cannot be decrypted", () => {
    const prev = process.env["DOTENV_PRIVATE_KEY"];
    delete process.env["DOTENV_PRIVATE_KEY"];
    const { session, calls } = fakeVaultSession();
    return run(session, { my_secret: ENCRYPTED_VALUE }).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          // No DOTENV_PRIVATE_KEY → Go aborts config load; the sync must fail and
          // never open a transaction (no BEGIN, no writes).
          expect(Exit.isFailure(exit)).toBe(true);
          expect(calls.some((c) => c.sql === "BEGIN")).toBe(false);
          expect(calls.some((c) => c.sql.includes("create_secret"))).toBe(false);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (prev !== undefined) process.env["DOTENV_PRIVATE_KEY"] = prev;
        }),
      ),
    );
  });
});
