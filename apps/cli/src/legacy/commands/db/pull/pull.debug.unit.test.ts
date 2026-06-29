import { describe, expect, it } from "vitest";

import {
  legacyFormatByteSize,
  legacyFormatCatalogSummary,
  legacyFormatConnectionInfo,
  legacyFormatEmptyPgDeltaPullSummary,
  legacyRedactPostgresURL,
  legacySummarizeCatalogJson,
} from "./pull.debug.ts";

// ANSI may wrap the bold debugDir; strip for assertions.
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");

describe("legacyRedactPostgresURL", () => {
  it("replaces the password but keeps the username", () => {
    expect(legacyRedactPostgresURL("postgresql://postgres:secret@db.host:5432/postgres")).toBe(
      "postgresql://postgres:xxxxx@db.host:5432/postgres",
    );
  });

  it("uses 'redacted' as the username when only a password is present", () => {
    expect(legacyRedactPostgresURL("postgresql://:secret@db.host:5432/postgres")).toBe(
      "postgresql://redacted:xxxxx@db.host:5432/postgres",
    );
  });

  it("leaves a URL without userinfo unchanged", () => {
    expect(legacyRedactPostgresURL("postgresql://db.host:5432/postgres")).toBe(
      "postgresql://db.host:5432/postgres",
    );
  });

  it("returns <invalid-url> on a parse failure", () => {
    expect(legacyRedactPostgresURL("not a url")).toBe("<invalid-url>");
  });
});

describe("legacyFormatConnectionInfo", () => {
  it("renders a single redacted line and never leaks the password", () => {
    const info = legacyFormatConnectionInfo(
      { host: "db.host", port: 5432, user: "postgres", database: "postgres" },
      "postgresql://postgres:secret@db.host:5432/postgres",
    );
    expect(info).toBe(
      "host=db.host port=5432 user=postgres database=postgres url=postgresql://postgres:xxxxx@db.host:5432/postgres",
    );
    expect(info).not.toContain("secret");
  });
});

describe("legacySummarizeCatalogJson", () => {
  it("counts objects grouped by schema name (string and nested forms)", () => {
    const catalog = JSON.stringify({
      tables: [
        { schema: "public", name: "t1" },
        { schema: "public", name: "t2" },
        { schema: { name: "auth" }, name: "users" },
      ],
    });
    const summary = legacySummarizeCatalogJson(catalog);
    expect(summary.totalObjects).toBe(3);
    expect(summary.bySchema).toEqual({ public: 2, auth: 1 });
  });

  it("returns an empty summary for blank or invalid JSON", () => {
    expect(legacySummarizeCatalogJson("")).toEqual({ totalObjects: 0, bySchema: {} });
    expect(legacySummarizeCatalogJson("{not json")).toEqual({ totalObjects: 0, bySchema: {} });
  });
});

describe("legacyFormatCatalogSummary", () => {
  it("reports no objects detected for an empty catalog", () => {
    expect(legacyFormatCatalogSummary("Shadow", { totalObjects: 0, bySchema: {} })).toBe(
      "Shadow catalog: no objects detected",
    );
  });

  it("lists object counts per schema", () => {
    expect(legacyFormatCatalogSummary("Remote", { totalObjects: 2, bySchema: { public: 2 } })).toBe(
      "Remote catalog: 2 objects (public=2)",
    );
  });
});

describe("legacyFormatByteSize", () => {
  it("formats B / KB / MB like Go", () => {
    expect(legacyFormatByteSize(512)).toBe("512 B");
    expect(legacyFormatByteSize(2048)).toBe("2.0 KB");
    expect(legacyFormatByteSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("legacyFormatEmptyPgDeltaPullSummary", () => {
  it("includes both catalog summaries when present", () => {
    const out = stripAnsi(
      legacyFormatEmptyPgDeltaPullSummary(
        "supabase/.temp/pgdelta/debug/20240101-000000",
        JSON.stringify({ t: [{ schema: "public", name: "a" }] }),
        JSON.stringify({ t: [{ schema: "public", name: "a" }] }),
      ),
    );
    expect(out).toContain("pg-delta returned 0 statements.");
    expect(out).toContain("Debug bundle saved to supabase/.temp/pgdelta/debug/20240101-000000");
    expect(out).toContain("Shadow catalog: 1 objects (public=1)");
    expect(out).toContain("Remote catalog: 1 objects (public=1)");
  });

  it("notes a failed/empty remote catalog export", () => {
    const out = stripAnsi(legacyFormatEmptyPgDeltaPullSummary("d", "", ""));
    expect(out).toContain(
      "Remote catalog: export failed or empty (inspect connection.txt and pgdelta-stderr.txt)",
    );
    expect(out).not.toContain("Shadow catalog:");
  });
});
