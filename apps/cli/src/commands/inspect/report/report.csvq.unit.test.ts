import { Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  type LegacyCsvTableProvider,
  LegacyInspectCsvqError,
  legacyEvalCsvqScalar,
  legacyParseReportCsv,
} from "./report.csvq.ts";
import { LEGACY_DEFAULT_INSPECT_RULES } from "./report.rules.ts";

function provider(tables: Record<string, string>): LegacyCsvTableProvider {
  return (name) => (name in tables ? legacyParseReportCsv(tables[name]!) : undefined);
}

const rule = (name: string): string => {
  const found = LEGACY_DEFAULT_INSPECT_RULES.find((r) => r.name === name);
  if (found === undefined) throw new Error(`no rule named ${name}`);
  return found.query;
};

function evalScalar(query: string, tables: Record<string, string>): Option.Option<string> {
  return legacyEvalCsvqScalar(query, provider(tables));
}

describe("legacyParseReportCsv", () => {
  it("indexes headers case-insensitively and parses RFC4180 quoted fields", () => {
    const table = legacyParseReportCsv('name,stmt\npublic.t,"SELECT a, b\nFROM t"\n');
    expect(table.columns.get("name")).toBe(0);
    expect(table.columns.get("stmt")).toBe(1);
    expect(table.rows).toEqual([["public.t", "SELECT a, b\nFROM t"]]);
  });

  it("reads a quoted empty field and an unquoted empty field both as empty strings", () => {
    const table = legacyParseReportCsv('a,b,c\n"",,x\n');
    expect(table.rows).toEqual([["", "", "x"]]);
  });

  it("returns an empty table for header-only input", () => {
    const table = legacyParseReportCsv("a,b\n");
    expect(table.rows).toEqual([]);
  });
});

describe("default rules — pass and fail fixtures", () => {
  it("No old locks: fails for an old lock, passes otherwise", () => {
    const q = rule("No old locks");
    expect(evalScalar(q, { "locks.csv": "stmt,age\nSELECT 1,00:05:00\n" })).toEqual(
      Option.some("SELECT 1"),
    );
    expect(evalScalar(q, { "locks.csv": "stmt,age\nSELECT 1,00:01:00\n" })).toEqual(Option.none());
  });

  it("No ungranted locks: fails on granted = 'f'", () => {
    const q = rule("No ungranted locks");
    expect(evalScalar(q, { "locks.csv": "stmt,granted\nLOCK A,f\n" })).toEqual(
      Option.some("LOCK A"),
    );
    expect(evalScalar(q, { "locks.csv": "stmt,granted\nLOCK A,t\n" })).toEqual(Option.none());
  });

  it("No unused indexes: LISTAGGs all rows with no WHERE, joined in order", () => {
    const q = rule("No unused indexes");
    expect(evalScalar(q, { "unused_indexes.csv": "index\nidx_a\nidx_b\n" })).toEqual(
      Option.some("idx_a,idx_b"),
    );
    expect(evalScalar(q, { "unused_indexes.csv": "index\n" })).toEqual(Option.none());
  });

  it("No duplicate indexes: reports indexes with the same table and columns", () => {
    const q = rule("No duplicate indexes");
    expect(
      evalScalar(q, {
        "index_stats.csv":
          "name,table,columns\npublic.idx_a,public.accounts,user_id\npublic.idx_b,public.accounts,user_id\npublic.idx_c,public.accounts,email\n",
      }),
    ).toEqual(Option.some("public.idx_a,public.idx_b"));
    expect(
      evalScalar(q, {
        "index_stats.csv":
          "name,table,columns\npublic.idx_a,public.accounts,user_id\npublic.idx_c,public.accounts,email\n",
      }),
    ).toEqual(Option.none());
  });

  it("Check cache hit: numeric compare with OR and string concatenation", () => {
    const q = rule("Check cache hit is within acceptable bounds");
    expect(
      evalScalar(q, {
        "db_stats.csv": "name,index_hit_rate,table_hit_rate\npostgres,0.90,0.99\n",
      }),
    ).toEqual(Option.some("index: 0.90, table: 0.99"));
    expect(
      evalScalar(q, {
        "db_stats.csv": "name,index_hit_rate,table_hit_rate\npostgres,0.99,0.99\n",
      }),
    ).toEqual(Option.none());
  });

  it("Check cache hit: a non-numeric ratio (N/A) string-compares and is excluded", () => {
    const q = rule("Check cache hit is within acceptable bounds");
    expect(
      evalScalar(q, {
        "db_stats.csv": "name,index_hit_rate,table_hit_rate\npostgres,N/A,N/A\n",
      }),
    ).toEqual(Option.none());
  });

  it("Sequential scans: arithmetic + AND with alias refs", () => {
    const q = rule("No large tables with sequential scans more than 10% of rows");
    expect(
      evalScalar(q, {
        "table_stats.csv": "name,seq_scans,estimated_row_count\npublic.t,500,2000\n",
      }),
    ).toEqual(Option.some("public.t"));
    // estimated_row_count <= 1000 → excluded by the second predicate.
    expect(
      evalScalar(q, {
        "table_stats.csv": "name,seq_scans,estimated_row_count\npublic.t,500,500\n",
      }),
    ).toEqual(Option.none());
  });

  it("Waiting on autovacuum: uses the vacuum_stats name column", () => {
    const q = rule("No large tables waiting on autovacuum");
    expect(
      evalScalar(q, {
        "vacuum_stats.csv": "name,expect_autovacuum,rowcount\npublic.t,yes,2000\n",
      }),
    ).toEqual(Option.some("public.t"));
    expect(
      evalScalar(q, {
        "vacuum_stats.csv": "name,expect_autovacuum,rowcount\npublic.t,no,2000\n",
      }),
    ).toEqual(Option.none());
  });

  it("evaluator mechanics: alias-qualified string + numeric AND predicate", () => {
    // Generic query (not a default rule) covering `s.col` alias refs, string `=`,
    // numeric `>`, and AND against the real vacuum_stats columns.
    const q =
      "SELECT LISTAGG(s.name, ',') FROM `vacuum_stats.csv` s WHERE s.expect_autovacuum = 'yes' AND s.rowcount > 1000";
    expect(
      evalScalar(q, {
        "vacuum_stats.csv": "name,expect_autovacuum,rowcount\npublic.t,yes,2000\n",
      }),
    ).toEqual(Option.some("public.t"));
    expect(
      evalScalar(q, {
        "vacuum_stats.csv": "name,expect_autovacuum,rowcount\npublic.t,no,2000\n",
      }),
    ).toEqual(Option.none());
  });

  it("Yet to be vacuumed: empty-string compare inside parenthesised OR", () => {
    const q = rule("No tables yet to be vacuumed");
    expect(
      evalScalar(q, {
        "vacuum_stats.csv":
          "name,rowcount,last_autovacuum,last_vacuum\npublic.t,2000,,2024-01-01 00:00\n",
      }),
    ).toEqual(Option.some("public.t"));
    expect(
      evalScalar(q, {
        "vacuum_stats.csv":
          "name,rowcount,last_autovacuum,last_vacuum\npublic.t,2000,2024-01-01 00:00,2024-01-01 00:00\n",
      }),
    ).toEqual(Option.none());
  });

  it("Dead rows: supports FLOAT(REPLACE(...)) for thousands-grouped counts", () => {
    const q = rule("No tables with more than 20% dead rows");
    expect(
      evalScalar(q, {
        "vacuum_stats.csv": 'name,rowcount,dead_rowcount\npublic.t,"2,000",501\n',
      }),
    ).toEqual(Option.some("public.t"));
    expect(
      evalScalar(q, {
        "vacuum_stats.csv": 'name,rowcount,dead_rowcount\npublic.t,"2,000",100\n',
      }),
    ).toEqual(Option.none());
  });

  it("New report health rules inspect replication slots, blocking, long running queries, and bloat", () => {
    expect(
      evalScalar(rule("No inactive replication slots"), {
        "replication_slots.csv": "slot_name,active\nslot_a,f\nslot_b,t\n",
      }),
    ).toEqual(Option.some("slot_a"));
    expect(
      evalScalar(rule("No blocked queries"), {
        "blocking.csv": "blocked_pid\n42\n",
      }),
    ).toEqual(Option.some("42"));
    expect(
      evalScalar(rule("No queries running longer than 5 minutes"), {
        "long_running_queries.csv": "pid\n99\n",
      }),
    ).toEqual(Option.some("99"));
    expect(
      evalScalar(rule("No tables or indexes with bloat ratio above 4x"), {
        "bloat.csv": "name,bloat\npublic.t,4.1\npublic.ok,2\n",
      }),
    ).toEqual(Option.some("public.t"));
  });
});

describe("csvq value semantics", () => {
  it("NOT negates a comparison", () => {
    expect(
      evalScalar("SELECT LISTAGG(stmt, ',') FROM `locks.csv` WHERE NOT granted = 't'", {
        "locks.csv": "stmt,granted\nA,f\nB,t\n",
      }),
    ).toEqual(Option.some("A"));
  });

  it("joins multiple matched rows in scan order with the separator", () => {
    expect(
      evalScalar("SELECT LISTAGG(stmt, ';') FROM `locks.csv` WHERE granted = 'f'", {
        "locks.csv": "stmt,granted\nA,f\nB,f\nC,t\n",
      }),
    ).toEqual(Option.some("A;B"));
  });

  it("COUNT(*) returns the matched row count", () => {
    expect(
      evalScalar("SELECT COUNT(*) FROM `locks.csv` WHERE granted = 'f'", {
        "locks.csv": "stmt,granted\nA,f\nB,f\nC,t\n",
      }),
    ).toEqual(Option.some("2"));
  });

  it("string-compares a thousands-grouped to_char value (csvq parity quirk)", () => {
    // `" 2,000"` is not strictly numeric (leading space, comma), so `rowcount > 1000`
    // falls back to a string comparison: `" 2,000"` < `"1000"` → the row is excluded,
    // exactly as csvq behaves on a `to_char`-formatted column.
    expect(
      evalScalar("SELECT LISTAGG(tbl, ',') FROM `vacuum_stats.csv` WHERE rowcount > 1000", {
        "vacuum_stats.csv": 'tbl,rowcount\npublic.t," 2,000"\n',
      }),
    ).toEqual(Option.none());
  });
});

describe("comparison operators", () => {
  const data = { "t.csv": "n\n5\n" };
  it.each([
    ["n = 5", true],
    ["n = 6", false],
    ["n <> 6", true],
    ["n != 5", false],
    ["n < 6", true],
    ["n <= 5", true],
    ["n > 4", true],
    ["n >= 6", false],
  ])("%s → matched=%s", (cond, matched) => {
    const result = evalScalar(`SELECT COUNT(*) FROM \`t.csv\` WHERE ${cond}`, data);
    expect(result).toEqual(Option.some(matched ? "1" : "0"));
  });

  it("string-compares when one side is a non-numeric string", () => {
    // `name = 'postgres'` is a pure string comparison.
    expect(
      evalScalar("SELECT COUNT(*) FROM `t.csv` WHERE name = 'postgres'", {
        "t.csv": "name\npostgres\nother\n",
      }),
    ).toEqual(Option.some("1"));
  });
});

describe("arithmetic", () => {
  it("supports + - * / and excludes rows when an operand is non-numeric (NULL result)", () => {
    const data = { "t.csv": "a,b\n10,4\n" };
    expect(evalScalar("SELECT COUNT(*) FROM `t.csv` WHERE a + b > 13", data)).toEqual(
      Option.some("1"),
    );
    expect(evalScalar("SELECT COUNT(*) FROM `t.csv` WHERE a - b > 5", data)).toEqual(
      Option.some("1"),
    );
    expect(evalScalar("SELECT COUNT(*) FROM `t.csv` WHERE a / b > 2", data)).toEqual(
      Option.some("1"),
    );
    // Division by zero → NULL → row excluded.
    expect(evalScalar("SELECT COUNT(*) FROM `t.csv` WHERE a / 0 > 0", data)).toEqual(
      Option.some("0"),
    );
    // Arithmetic on a non-numeric column → NULL → row excluded.
    expect(
      evalScalar("SELECT COUNT(*) FROM `t.csv` WHERE c * 1 > 0", { "t.csv": "c\nabc\n" }),
    ).toEqual(Option.some("0"));
  });
});

describe("IS NULL", () => {
  it("treats a computed NULL as IS NULL and a CSV cell as never NULL", () => {
    expect(
      evalScalar("SELECT COUNT(*) FROM `t.csv` WHERE c * 1 IS NULL", { "t.csv": "c\nabc\n" }),
    ).toEqual(Option.some("1"));
    expect(
      evalScalar("SELECT COUNT(*) FROM `t.csv` WHERE c IS NOT NULL", { "t.csv": "c\nabc\n" }),
    ).toEqual(Option.some("1"));
    expect(
      evalScalar("SELECT COUNT(*) FROM `t.csv` WHERE c IS NULL", { "t.csv": "c\nabc\n" }),
    ).toEqual(Option.some("0"));
  });
});

describe("aggregates", () => {
  const data = { "t.csv": "v\n10\n20\n30\n" };
  it("COUNT(col) counts the matched rows", () => {
    expect(evalScalar("SELECT COUNT(v) FROM `t.csv`", data)).toEqual(Option.some("3"));
  });
  it("SUM / AVG / MIN / MAX over numeric cells", () => {
    expect(evalScalar("SELECT SUM(v) FROM `t.csv`", data)).toEqual(Option.some("60"));
    expect(evalScalar("SELECT AVG(v) FROM `t.csv`", data)).toEqual(Option.some("20"));
    expect(evalScalar("SELECT MIN(v) FROM `t.csv`", data)).toEqual(Option.some("10"));
    expect(evalScalar("SELECT MAX(v) FROM `t.csv`", data)).toEqual(Option.some("30"));
  });
  it("a numeric aggregate over zero matched rows is none", () => {
    expect(evalScalar("SELECT SUM(v) FROM `t.csv` WHERE v > 100", data)).toEqual(Option.none());
  });
});

describe("plain column select", () => {
  it("returns the first matched cell, or none when nothing matches", () => {
    const data = { "t.csv": "name,flag\na,x\nb,y\n" };
    expect(evalScalar("SELECT name FROM `t.csv` WHERE flag = 'y'", data)).toEqual(Option.some("b"));
    expect(evalScalar("SELECT name FROM `t.csv` WHERE flag = 'z'", data)).toEqual(Option.none());
  });
});

describe("errors", () => {
  it("throws for an unknown table", () => {
    expect(() => evalScalar("SELECT COUNT(*) FROM `missing.csv`", {})).toThrow(
      LegacyInspectCsvqError,
    );
  });

  it("throws for an unknown column", () => {
    expect(() =>
      evalScalar("SELECT LISTAGG(nope, ',') FROM `locks.csv`", { "locks.csv": "stmt\nA\n" }),
    ).toThrow(LegacyInspectCsvqError);
  });

  it("throws for unsupported grammar", () => {
    expect(() =>
      evalScalar("UPDATE `locks.csv` SET stmt = 'x'", { "locks.csv": "stmt\nA\n" }),
    ).toThrow(LegacyInspectCsvqError);
  });
});
