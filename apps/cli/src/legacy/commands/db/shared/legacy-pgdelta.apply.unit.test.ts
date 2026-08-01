import { describe, expect, test } from "vitest";

import {
  legacyFormatApplyFailure,
  legacyFormatDebugJson,
  type LegacyPgDeltaApplyDiagnosis,
  type LegacyPgDeltaApplyIssue,
  type LegacyPgDeltaApplyResult,
  type LegacyPgDeltaApplyStatementLocation,
} from "./legacy-pgdelta.apply.ts";

describe("legacyFormatApplyFailure", () => {
  test("renders the status + counts summary line, with no per-statement sections when there are no issues", () => {
    const result: LegacyPgDeltaApplyResult = {
      status: "error",
      totalStatements: 4,
      totalRounds: 2,
      totalApplied: 3,
      totalSkipped: 1,
    };
    const message = legacyFormatApplyFailure(result, false);
    expect(message).toContain('pg-delta apply returned status "error".');
    expect(message).toContain("3/4 statements applied in 2 round(s); 1 skipped.");
    expect(message).toContain("No per-statement diagnostics were reported by pg-delta.");
    expect(message).toContain("https://github.com/supabase/pg-toolbelt/issues");
  });

  test("derives totalStatements from applied + skipped + stuck when omitted", () => {
    const result: LegacyPgDeltaApplyResult = {
      status: "error",
      totalRounds: 1,
      totalApplied: 2,
      totalSkipped: 1,
      stuckStatements: ["stuck one"],
    };
    const message = legacyFormatApplyFailure(result, false);
    expect(message).toContain("2/4 statements applied in 1 round(s); 1 skipped.");
  });

  test("renders a structured issue with no `statement` field as its message, with SQLSTATE/position/dependency metadata appended", () => {
    const issue: LegacyPgDeltaApplyIssue = {
      message: "relation already exists",
      code: "42P07",
      position: 15,
      isDependencyError: true,
    };
    const result: LegacyPgDeltaApplyResult = {
      status: "error",
      totalApplied: 0,
      totalRounds: 1,
      totalSkipped: 0,
      errors: [issue],
    };
    const message = legacyFormatApplyFailure(result, false);
    expect(message).toContain("Errors:");
    expect(message).toContain(
      "- relation already exists (SQLSTATE 42P07, position 15, dependency error)",
    );
  });

  test("renders a genuine bare string issue (Go's ApplyIssue string-arm) as its own message", () => {
    const result: LegacyPgDeltaApplyResult = {
      status: "error",
      totalApplied: 0,
      totalRounds: 1,
      totalSkipped: 0,
      errors: ["relation already exists"],
    };
    const message = legacyFormatApplyFailure(result, false);
    expect(message).toContain("Errors:\n- relation already exists");
  });

  test("renders a structured issue with its statement id/class, detail, hint, and truncated SQL", () => {
    const issue: LegacyPgDeltaApplyIssue = {
      message: "column does not exist",
      statement: {
        id: "001_add_column",
        statementClass: "alter_table",
        sql: "alter table t add column c int;",
      },
      detail: "Column c was dropped earlier in this plan.",
      hint: "Check the plan ordering.",
    };
    const result: LegacyPgDeltaApplyResult = {
      status: "error",
      totalApplied: 0,
      totalRounds: 1,
      totalSkipped: 0,
      errors: [issue],
    };
    const message = legacyFormatApplyFailure(result, false);
    expect(message).toContain("- 001_add_column [alter_table]");
    expect(message).toContain("  column does not exist");
    expect(message).toContain("  Detail: Column c was dropped earlier in this plan.");
    expect(message).toContain("  Hint: Check the plan ordering.");
    expect(message).toContain("  SQL: alter table t add column c int;");
  });

  test("stuck statements and validation errors get their own labeled sections", () => {
    const result: LegacyPgDeltaApplyResult = {
      status: "error",
      totalApplied: 0,
      totalRounds: 1,
      totalSkipped: 0,
      stuckStatements: ["still stuck"],
      validationErrors: ["bad function body"],
    };
    const message = legacyFormatApplyFailure(result, false);
    expect(message).toContain("Stuck statements:\n- still stuck");
    expect(message).toContain(
      "Validation errors (from check_function_bodies=on pass):\n- bad function body",
    );
  });

  test("diagnostics collapse to a one-line count unless verbose", () => {
    const result: LegacyPgDeltaApplyResult = {
      status: "error",
      totalApplied: 1,
      totalRounds: 1,
      totalSkipped: 0,
      errors: ["some error"],
      diagnostics: [{ message: "unused index" }, { message: "missing default" }],
    };
    const collapsed = legacyFormatApplyFailure(result, false);
    expect(collapsed).toContain("2 pg-topo diagnostic(s) omitted (re-run with --debug to view).");
    expect(collapsed).not.toContain("unused index");

    const verbose = legacyFormatApplyFailure(result, true);
    expect(verbose).toContain("Diagnostics:");
    expect(verbose).toContain("- unused index");
    expect(verbose).toContain("- missing default");
  });

  test("renders a partially-populated statement (missing sql/statementClass) without throwing", () => {
    // Reproduces feeding a real pg-delta subprocess's malformed stdout
    // (`{"errors":[{"message":"boom","statement":{"id":"s1"}}]}`) through
    // `legacyApplyDeclarativePgDelta` — that function only validates the top-level shape
    // (`{status: string}`), not nested fields, and this only ever runs on an
    // ALREADY-FAILED apply, so a formatter crash here would turn an actionable SQL error
    // into an unhandled defect.
    const parsed = JSON.parse(
      '{"status":"error","totalApplied":0,"totalRounds":1,"totalSkipped":0,"errors":[{"message":"boom","statement":{"id":"s1"}}]}',
    ) as LegacyPgDeltaApplyResult;
    expect(() => legacyFormatApplyFailure(parsed, false)).not.toThrow();
    const message = legacyFormatApplyFailure(parsed, false);
    expect(message).toContain("- s1");
    expect(message).toContain("  boom");
    expect(message).not.toContain("undefined");
  });

  test("renders an issue whose detail/hint/sql/statementClass arrived as non-strings without throwing", () => {
    // A malformed pg-delta payload can hand any of these fields a non-string value (e.g. a
    // future release that reports a numeric `detail`) — a bare `?? ""` guard (rather than
    // `String(x ?? "")`) would still pass the number straight to `.trim()`/`.split()` and throw.
    const parsed = JSON.parse(
      '{"status":"error","totalApplied":0,"totalRounds":1,"totalSkipped":0,"errors":[{"message":"boom","statement":{"id":"s1","statementClass":42,"sql":7},"detail":123,"hint":456}]}',
    ) as LegacyPgDeltaApplyResult;
    expect(() => legacyFormatApplyFailure(parsed, false)).not.toThrow();
    const message = legacyFormatApplyFailure(parsed, false);
    expect(message).toContain("- s1 [42]");
    expect(message).toContain("  Detail: 123");
    expect(message).toContain("  Hint: 456");
    expect(message).toContain("  SQL: 7");
  });

  test("renders a diagnosis whose message/code/suggestedFix arrived as non-strings without throwing", () => {
    const parsed = JSON.parse(
      '{"status":"error","totalApplied":0,"totalRounds":1,"totalSkipped":0,"errors":["e"],"diagnostics":[{"message":123,"code":456,"suggestedFix":789}]}',
    ) as LegacyPgDeltaApplyResult;
    expect(() => legacyFormatApplyFailure(parsed, true)).not.toThrow();
    const message = legacyFormatApplyFailure(parsed, true);
    expect(message).toContain("[456] 123");
    expect(message).toContain("Suggested fix: 789");
  });

  test("renders a diagnosis whose statementId.filePath arrived as a non-string without throwing", () => {
    // `filePath` is typed `string | undefined`, but this whole module types an untrusted
    // `JSON.parse` — a malformed payload can hand a non-string value at runtime, which a bare
    // `?? ""` guard (rather than `String(...) ?? ""`) would still pass straight to `.trim()`.
    const parsed = JSON.parse(
      '{"status":"error","totalApplied":0,"totalRounds":1,"totalSkipped":0,"errors":["e"],"diagnostics":[{"message":"d","statementId":{"filePath":123,"statementIndex":1}}]}',
    ) as LegacyPgDeltaApplyResult;
    expect(() => legacyFormatApplyFailure(parsed, true)).not.toThrow();
    const message = legacyFormatApplyFailure(parsed, true);
    expect(message).toContain("(123#1)");
  });

  test("a diagnosis with a statementId location and suggestedFix renders both", () => {
    const statementId: LegacyPgDeltaApplyStatementLocation = {
      filePath: "001_a.sql",
      statementIndex: 2,
    };
    const diagnosis: LegacyPgDeltaApplyDiagnosis = {
      code: "PGT001",
      message: "circular dependency",
      statementId,
      suggestedFix: "Split the statement across two files.",
    };
    const result: LegacyPgDeltaApplyResult = {
      status: "error",
      totalApplied: 1,
      totalRounds: 1,
      totalSkipped: 0,
      errors: ["some error"],
      diagnostics: [diagnosis],
    };
    const message = legacyFormatApplyFailure(result, true);
    expect(message).toContain("- [PGT001] circular dependency (001_a.sql#2)");
    expect(message).toContain("Suggested fix: Split the statement across two files.");
  });
});

describe("legacyFormatDebugJson", () => {
  test("pretty-prints valid JSON", () => {
    expect(legacyFormatDebugJson('{"status":"error","totalApplied":1}')).toBe(
      JSON.stringify({ status: "error", totalApplied: 1 }, null, 2),
    );
  });

  test("returns the trimmed raw string when it isn't valid JSON", () => {
    expect(legacyFormatDebugJson("  not json  ")).toBe("not json");
  });

  test("returns empty for blank input", () => {
    expect(legacyFormatDebugJson("   ")).toBe("");
  });
});
