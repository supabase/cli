import { describe, expect, it } from "vitest";

import {
  legacyFindPendingMigrations,
  legacyIncludeAllPending,
  legacySuggestIgnoreFlag,
  legacySuggestRevertHistory,
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
  it("builds the revert-history suggestion with a trailing newline per line", () => {
    expect(legacySuggestRevertHistory(["0002", "0003"])).toContain(
      "supabase migration repair --status reverted 0002 0003",
    );
    expect(legacySuggestRevertHistory(["0002"])).toMatch(/\n$/u);
    expect(legacySuggestRevertHistory(["0002"])).toContain("supabase db pull");
  });

  it("builds the include-all suggestion listing each path on its own line", () => {
    const suggestion = legacySuggestIgnoreFlag([
      "supabase/migrations/0001_a.sql",
      "supabase/migrations/0002_b.sql",
    ]);
    expect(suggestion).toContain("--include-all");
    expect(suggestion).toContain("supabase/migrations/0001_a.sql\nsupabase/migrations/0002_b.sql");
  });
});
