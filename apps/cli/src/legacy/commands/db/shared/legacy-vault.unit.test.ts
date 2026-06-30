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

function fakeVaultSession(opts: { failOn?: string } = {}) {
  const calls: Array<{ kind: "exec" | "query"; sql: string }> = [];
  const session: LegacyDbSession = {
    exec: (sql) => {
      calls.push({ kind: "exec", sql });
      return Effect.void;
    },
    query: (sql) => {
      calls.push({ kind: "query", sql });
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

  it("skips empty, env-reference, and encrypted values", () => {
    const result = legacySyncableVaultSecrets({
      empty: "",
      fromEnv: "env(MY_SECRET)",
      encrypted: "encrypted:abc",
      literal: "plain-value",
    });
    expect(result).toEqual([{ key: "literal", value: "plain-value" }]);
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
});
