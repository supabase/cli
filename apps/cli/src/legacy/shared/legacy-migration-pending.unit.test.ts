import { describe, expect, it } from "vitest";

import {
  legacyFindPendingMigrations,
  legacyIncludeAllPending,
  legacySuggestIgnoreFlag,
} from "./legacy-migration-pending.ts";

const local = (...versions: ReadonlyArray<string>) =>
  versions.map((v) => `supabase/migrations/${v}_name.sql`);

describe("legacyFindPendingMigrations", () => {
  it("returns the local migrations beyond the remote history when in sync", () => {
    const result = legacyFindPendingMigrations(local("0001", "0002", "0003"), ["0001"]);
    expect(result).toEqual({
      kind: "ok",
      pending: ["supabase/migrations/0002_name.sql", "supabase/migrations/0003_name.sql"],
    });
  });

  it("is up to date when local and remote match exactly", () => {
    const result = legacyFindPendingMigrations(local("0001", "0002"), ["0001", "0002"]);
    expect(result).toEqual({ kind: "ok", pending: [] });
  });

  it("is up to date when one version is a string prefix of another (#6036)", () => {
    // Not limited to long timestamps: any prefix pair inverts, because
    // `10_name.sql` sorts before `1_name.sql` by name ('0' < '_') while remote
    // reads back "1" before "10".
    const result = legacyFindPendingMigrations(local("10", "1"), ["1", "10"]);
    expect(result).toEqual({ kind: "ok", pending: [] });
  });

  it("is up to date when an 8-digit and a 14-digit version share a prefix (#6036)", () => {
    // Local files arrive in name order, where `20260420010000_name.sql` precedes
    // `20260420_name.sql` ('0' < '_') — the reverse of the version order
    // `schema_migrations` is read back in.
    const result = legacyFindPendingMigrations(local("20260420010000", "20260420"), [
      "20260420",
      "20260420010000",
    ]);
    expect(result).toEqual({ kind: "ok", pending: [] });
  });

  it("returns mixed-width pending migrations in version order", () => {
    const result = legacyFindPendingMigrations(local("20260420010000", "20260420"), []);
    expect(result).toEqual({
      kind: "ok",
      pending: [
        "supabase/migrations/20260420_name.sql",
        "supabase/migrations/20260420010000_name.sql",
      ],
    });
  });

  it("reports missing-local when remote has a version with no local file", () => {
    const result = legacyFindPendingMigrations(local("0001", "0003"), ["0001", "0002", "0003"]);
    expect(result).toEqual({ kind: "missing-local", versions: ["0002"] });
  });

  it("reports missing-local for trailing remote versions absent locally", () => {
    const result = legacyFindPendingMigrations(local("0001"), ["0001", "0002"]);
    expect(result).toEqual({ kind: "missing-local", versions: ["0002"] });
  });

  it("reports missing-remote for an out-of-order local migration", () => {
    const result = legacyFindPendingMigrations(local("0001", "0002"), ["0002"]);
    expect(result).toEqual({
      kind: "missing-remote",
      paths: ["supabase/migrations/0001_name.sql"],
    });
  });

  it("treats an empty remote history as all-local pending", () => {
    const result = legacyFindPendingMigrations(local("0001", "0002"), []);
    expect(result).toEqual({
      kind: "ok",
      pending: ["supabase/migrations/0001_name.sql", "supabase/migrations/0002_name.sql"],
    });
  });
});

describe("legacyIncludeAllPending", () => {
  it("slices the version-ordered list, not the name-ordered one (#6036)", () => {
    // Local files arrive name-ordered as [20, 1, 2]; version order is [1, 2, 20].
    // With "2" applied, the diff is [1] and the slice must resume at "20".
    // Indexing the name-ordered list instead would return "2" — already applied —
    // and silently drop "20".
    const locals = local("20", "1", "2");
    const diff = ["supabase/migrations/1_name.sql"];
    expect(legacyIncludeAllPending(locals, 1, diff)).toEqual([
      "supabase/migrations/1_name.sql",
      "supabase/migrations/20_name.sql",
    ]);
  });

  it("prepends the out-of-order diff then the migrations beyond remote+diff", () => {
    const locals = local("0001", "0002", "0003");
    const diff = ["supabase/migrations/0001_name.sql"];
    // remoteCount 1, diff length 1 → slice from index 2.
    expect(legacyIncludeAllPending(locals, 1, diff)).toEqual([
      "supabase/migrations/0001_name.sql",
      "supabase/migrations/0003_name.sql",
    ]);
  });
});

describe("suggestion strings", () => {
  it("builds the include-all suggestion listing each path on its own line", () => {
    const suggestion = legacySuggestIgnoreFlag([
      "supabase/migrations/0001_a.sql",
      "supabase/migrations/0002_b.sql",
    ]);
    expect(suggestion).toContain("--include-all");
    expect(suggestion).toContain("supabase/migrations/0001_a.sql\nsupabase/migrations/0002_b.sql");
  });
});
