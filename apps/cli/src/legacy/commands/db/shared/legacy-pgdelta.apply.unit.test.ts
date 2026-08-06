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
    const message = legacyFormatApplyFailure(result, false).toString("utf-8");
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
    const message = legacyFormatApplyFailure(result, false).toString("utf-8");
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
    const message = legacyFormatApplyFailure(result, false).toString("utf-8");
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
    const message = legacyFormatApplyFailure(result, false).toString("utf-8");
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
    const message = legacyFormatApplyFailure(result, false).toString("utf-8");
    expect(message).toContain("- 001_add_column [alter_table]");
    expect(message).toContain("  column does not exist");
    expect(message).toContain("  Detail: Column c was dropped earlier in this plan.");
    expect(message).toContain("  Hint: Check the plan ordering.");
    expect(message).toContain("  SQL: alter table t add column c int;");
  });

  test("truncates a multibyte SQL statement by UTF-8 bytes, not UTF-16 code units", () => {
    // Go's `formatStatementSQL` (`apply.go:277-283`) truncates via `len(normalized)` and
    // `normalized[:maxLen-3]`, both of which count/slice raw UTF-8 bytes. 70 repetitions of a
    // single 3-byte CJK character is only 70 JS UTF-16 code units (well under the 120-char
    // threshold a naive `.length`/`.slice()` guard would use — it would never truncate at all),
    // but 210 UTF-8 bytes — well over Go's 120-byte limit. `117 / 3 === 39` lands the byte cut
    // exactly on a codepoint boundary, so the expected output is unambiguous.
    const sql = "字".repeat(70);
    const issue: LegacyPgDeltaApplyIssue = {
      message: "boom",
      statement: { id: "001_a", sql },
    };
    const result: LegacyPgDeltaApplyResult = {
      status: "error",
      totalApplied: 0,
      totalRounds: 1,
      totalSkipped: 0,
      errors: [issue],
    };
    const message = legacyFormatApplyFailure(result, false).toString("utf-8");
    expect(sql.length).toBeLessThanOrEqual(120);
    expect(Buffer.byteLength(sql, "utf-8")).toBe(210);
    expect(message).toContain(`  SQL: ${"字".repeat(39)}...`);
    expect(message).not.toContain(sql);
  });

  test("collapses a NEL (U+0085) as whitespace, matching Go's unicode.IsSpace, unlike ECMAScript's `\\s`", () => {
    // Go's `formatStatementSQL` (`apply.go:277-283`) normalizes via `strings.Fields`, which
    // splits on `unicode.IsSpace` — and `unicode.IsSpace(0x85)` (NEL) is `true` (verified
    // empirically), so a NEL embedded in a user's SQL statement is collapsed like any other
    // run of whitespace. ECMAScript's `\s` does NOT match NEL, so a naive `.split(/\s+/u)`
    // would preserve it verbatim instead of collapsing it.
    const nel = String.fromCodePoint(0x85);
    const sql = `select${nel}1;`;
    const issue: LegacyPgDeltaApplyIssue = {
      message: "boom",
      statement: { id: "001_a", sql },
    };
    const result: LegacyPgDeltaApplyResult = {
      status: "error",
      totalApplied: 0,
      totalRounds: 1,
      totalSkipped: 0,
      errors: [issue],
    };
    const message = legacyFormatApplyFailure(result, false).toString("utf-8");
    expect(message).toContain("  SQL: select 1;");
    expect(message).not.toContain(nel);
  });

  test("preserves a BOM (U+FEFF) instead of treating it as whitespace, matching Go's unicode.IsSpace, unlike ECMAScript's `\\s`", () => {
    // The opposite gap from the NEL case above: `unicode.IsSpace(0xFEFF)` (BOM) is `false`
    // (verified empirically), so Go's `strings.Fields` keeps a BOM embedded mid-statement as
    // part of the surrounding "word" rather than treating it as a separator. ECMAScript's `\s`
    // DOES match a BOM, so a naive `.split(/\s+/u)` would incorrectly split on it.
    const bom = String.fromCodePoint(0xfeff);
    const sql = `select${bom}1;`;
    const issue: LegacyPgDeltaApplyIssue = {
      message: "boom",
      statement: { id: "001_a", sql },
    };
    const result: LegacyPgDeltaApplyResult = {
      status: "error",
      totalApplied: 0,
      totalRounds: 1,
      totalSkipped: 0,
      errors: [issue],
    };
    const message = legacyFormatApplyFailure(result, false).toString("utf-8");
    expect(message).toContain(`  SQL: select${bom}1;`);
  });

  test("preserves Go's exact (possibly invalid-UTF-8) truncated bytes when the byte cut lands mid-codepoint", () => {
    // Unlike the boundary-aligned CJK-repeat case above, a single leading ASCII byte shifts
    // every subsequent 3-byte CJK character by one, so the byte-117 cut now lands ONE byte
    // into a character instead of exactly on a boundary — reproducing the pathological case
    // where Go's raw `normalized[:117]` slice is intentionally invalid UTF-8. Verified against
    // Go's own `formatStatementSQL` (`apply.go:277-283`): slicing this exact byte range
    // produces a 120-byte result that `unicode/utf8.ValidString` reports as `false`. A naive
    // `Buffer#toString("utf-8")` truncation would instead substitute U+FFFD for the incomplete
    // trailing sequence, corrupting the byte-exact stderr contract.
    const sql = `a${"字".repeat(60)}`;
    const issue: LegacyPgDeltaApplyIssue = {
      message: "boom",
      statement: { id: "001_a", sql },
    };
    const result: LegacyPgDeltaApplyResult = {
      status: "error",
      totalApplied: 0,
      totalRounds: 1,
      totalSkipped: 0,
      errors: [issue],
    };
    const message = legacyFormatApplyFailure(result, false);
    const normalizedBytes = Buffer.from(sql, "utf-8");
    const expectedTruncatedTail = Buffer.concat([
      normalizedBytes.subarray(0, 117),
      Buffer.from("...", "utf-8"),
    ]);
    expect(expectedTruncatedTail.byteLength).toBe(120);
    expect(
      message.includes(Buffer.concat([Buffer.from("  SQL: ", "utf-8"), expectedTruncatedTail])),
    ).toBe(true);
    // No replacement character (the tell-tale sign of a lossy UTF-8 decode/re-encode
    // round-trip) should ever appear in the output.
    expect(message.includes(Buffer.from("�", "utf-8"))).toBe(false);
  });

  test("treats a null errors/stuckStatements/validationErrors/diagnostics array as empty, matching Go's nil-slice decode", () => {
    // Go's `encoding/json` accepts a JSON `null` for a `[]T` slice field with no error,
    // leaving a nil (zero-length) slice — verified empirically:
    // `json.Unmarshal([]byte(\`{"status":"error","errors":null}\`), &r)` returns `err == nil`
    // with `len(r.Errors) == 0`. `legacyFormatApplyFailure` itself already treats a JS `null`/
    // `undefined` array as empty via `?? []`; this exercises that the TYPE also tolerates it
    // (the earlier structural-guard bug — `legacyIsPgDeltaApplyResult` — is covered by the
    // integration test in `legacy-pgdelta.apply.integration.test.ts`, since it isn't exported).
    const result: LegacyPgDeltaApplyResult = {
      status: "error",
      totalApplied: 0,
      totalRounds: 1,
      totalSkipped: 0,
      errors: null,
      stuckStatements: null,
      validationErrors: null,
      diagnostics: null,
    };
    const message = legacyFormatApplyFailure(result, false).toString("utf-8");
    expect(message).toContain("No per-statement diagnostics were reported by pg-delta.");
    expect(message).not.toContain("Errors:");
    expect(message).not.toContain("Stuck statements:");
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
    const message = legacyFormatApplyFailure(result, false).toString("utf-8");
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
    const collapsed = legacyFormatApplyFailure(result, false).toString("utf-8");
    expect(collapsed).toContain("2 pg-topo diagnostic(s) omitted (re-run with --debug to view).");
    expect(collapsed).not.toContain("unused index");

    const verbose = legacyFormatApplyFailure(result, true).toString("utf-8");
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
    expect(() => legacyFormatApplyFailure(parsed, false).toString("utf-8")).not.toThrow();
    const message = legacyFormatApplyFailure(parsed, false).toString("utf-8");
    expect(message).toContain("- s1");
    expect(message).toContain("  boom");
    expect(message).not.toContain("undefined");
  });

  test("renders an issue with a null `statement` field as its message, without throwing", () => {
    // Reproduces feeding a real pg-delta subprocess's stdout
    // (`{"errors":[{"statement":null,"message":"failed"}]}`) through
    // `legacyApplyDeclarativePgDelta` — Go's `Statement *ApplyStatement` is a pointer, so
    // `"statement":null` unmarshals to `nil` and `formatApplyIssue`'s `issue.Statement == nil`
    // (`apply.go:202`) treats it identically to a missing field. A no-statement guard that only
    // checks `=== undefined` would fall through to `issue.statement.statementClass` on `null`
    // and throw a `TypeError` instead of rendering the message.
    const parsed = JSON.parse(
      '{"status":"error","totalApplied":0,"totalRounds":1,"totalSkipped":0,"errors":[{"statement":null,"message":"failed"}]}',
    ) as LegacyPgDeltaApplyResult;
    expect(() => legacyFormatApplyFailure(parsed, false).toString("utf-8")).not.toThrow();
    const message = legacyFormatApplyFailure(parsed, false).toString("utf-8");
    expect(message).toContain("Errors:\n- failed");
  });

  test("renders an issue whose detail/hint/sql/statementClass arrived as non-strings without throwing", () => {
    // A malformed pg-delta payload can hand any of these fields a non-string value (e.g. a
    // future release that reports a numeric `detail`) — a bare `?? ""` guard (rather than
    // `String(x ?? "")`) would still pass the number straight to `.trim()`/`.split()` and throw.
    const parsed = JSON.parse(
      '{"status":"error","totalApplied":0,"totalRounds":1,"totalSkipped":0,"errors":[{"message":"boom","statement":{"id":"s1","statementClass":42,"sql":7},"detail":123,"hint":456}]}',
    ) as LegacyPgDeltaApplyResult;
    expect(() => legacyFormatApplyFailure(parsed, false).toString("utf-8")).not.toThrow();
    const message = legacyFormatApplyFailure(parsed, false).toString("utf-8");
    expect(message).toContain("- s1 [42]");
    expect(message).toContain("  Detail: 123");
    expect(message).toContain("  Hint: 456");
    expect(message).toContain("  SQL: 7");
  });

  test("renders a diagnosis whose message/code/suggestedFix arrived as non-strings without throwing", () => {
    const parsed = JSON.parse(
      '{"status":"error","totalApplied":0,"totalRounds":1,"totalSkipped":0,"errors":["e"],"diagnostics":[{"message":123,"code":456,"suggestedFix":789}]}',
    ) as LegacyPgDeltaApplyResult;
    expect(() => legacyFormatApplyFailure(parsed, true).toString("utf-8")).not.toThrow();
    const message = legacyFormatApplyFailure(parsed, true).toString("utf-8");
    expect(message).toContain("[456] 123");
    expect(message).toContain("Suggested fix: 789");
  });

  test("drops a diagnosis's statementId when a nested field is mistyped, matching Go's nil fallback", () => {
    // Go's `(d *ApplyDiagnosis) UnmarshalJSON` (`apply.go:79-108`) tries decoding `statementId`
    // as an `ApplyStatementLocation` object first; a mistyped `filePath` (a number, not a
    // string) fails that decode, and its bare-string fallback ALSO fails since the value is an
    // object, not a string — so Go silently leaves `StatementID` nil, never erroring the whole
    // `ApplyResult` parse. Verified empirically against Go's real struct + fallback chain:
    // `{"statementId":{"filePath":123,"statementIndex":1}}` decodes with `StatementID == nil`.
    // Rendering the raw object anyway (coercing `filePath` via `String(123)`) would show a
    // bogus `(123#1)` location Go never emits.
    const parsed = JSON.parse(
      '{"status":"error","totalApplied":0,"totalRounds":1,"totalSkipped":0,"errors":["e"],"diagnostics":[{"message":"d","statementId":{"filePath":123,"statementIndex":1}}]}',
    ) as LegacyPgDeltaApplyResult;
    expect(() => legacyFormatApplyFailure(parsed, true).toString("utf-8")).not.toThrow();
    const message = legacyFormatApplyFailure(parsed, true).toString("utf-8");
    expect(message).toContain("- d");
    expect(message).not.toContain("123#1");
    expect(message).not.toContain("(123");
  });

  test("drops a diagnosis's statementId when sourceOffset is mistyped, even though the location renderer never reads it", () => {
    // Go's struct-level `json.Unmarshal` into `ApplyStatementLocation` (`apply.go:73-77`)
    // fails the moment ANY declared field has the wrong type — including `sourceOffset`,
    // which `legacyFormatStatementLocation`/Go's own `formatStatementLocation` never
    // display. Verified empirically against Go's real struct:
    // `json.Unmarshal([]byte(\`{"filePath":"x.sql","sourceOffset":"bad"}\`), &loc)` returns a
    // non-nil error even though `filePath` itself is well-typed, so the object-shape decode
    // fails, the bare-string fallback also fails (the value is an object, not a string), and
    // Go leaves `StatementID` nil — the location must be dropped, not rendered as `(x.sql)`,
    // which would misattribute the diagnostic to a file Go never resolved.
    const parsed = JSON.parse(
      '{"status":"error","totalApplied":0,"totalRounds":1,"totalSkipped":0,"errors":["e"],"diagnostics":[{"message":"d","statementId":{"filePath":"x.sql","sourceOffset":"bad"}}]}',
    ) as LegacyPgDeltaApplyResult;
    expect(() => legacyFormatApplyFailure(parsed, true).toString("utf-8")).not.toThrow();
    const message = legacyFormatApplyFailure(parsed, true).toString("utf-8");
    expect(message).toContain("- d");
    expect(message).not.toContain("x.sql");
  });

  test("renders a diagnosis with a null statementId as having no location, without throwing", () => {
    // Reproduces a real pg-delta subprocess emitting
    // `{"diagnostics":[{"message":"failed","statementId":null}]}` — Go's
    // `(d *ApplyDiagnosis) UnmarshalJSON` (`apply.go:79-108`) explicitly maps a JSON
    // `"statementId":null` to a nil `*ApplyStatementLocation`, and `formatStatementLocation`
    // (`apply.go:263-274`) returns `""` for a nil pointer. A guard that only checked
    // `resolved === undefined` (not `null`) would fall through to
    // `legacyFormatStatementLocation`'s `resolved.filePath` and dereference a `null`, throwing a
    // `TypeError` instead of rendering the rest of the diagnostic.
    const parsed = JSON.parse(
      '{"status":"error","totalApplied":0,"totalRounds":1,"totalSkipped":0,"errors":["e"],"diagnostics":[{"message":"failed","statementId":null}]}',
    ) as LegacyPgDeltaApplyResult;
    expect(() => legacyFormatApplyFailure(parsed, true).toString("utf-8")).not.toThrow();
    const message = legacyFormatApplyFailure(parsed, true).toString("utf-8");
    expect(message).toContain("- failed");
    expect(message).not.toContain("undefined");
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
    const message = legacyFormatApplyFailure(result, true).toString("utf-8");
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

  test("preserves an integer literal beyond Number.MAX_SAFE_INTEGER byte-for-byte", () => {
    // Go's `json.Indent` (`encoding/json/indent.go`) only inserts whitespace between existing
    // tokens — it never decodes a number into a value and re-encodes it. `JSON.parse` would
    // decode this literal into a `float64`-backed JS number, silently rounding it (verified:
    // `JSON.parse("9007199254740993").toString()` is `"9007199254740992"`), and
    // `JSON.stringify` would then re-emit the ROUNDED value — corrupting the exact debug
    // payload users are asked to attach to bug reports.
    const raw = '{"id":9007199254740993}';
    expect(legacyFormatDebugJson(raw)).toBe('{\n  "id": 9007199254740993\n}');
  });

  test("preserves an existing string escape's exact representation (e.g. an escaped forward slash)", () => {
    // Go's `json.Indent` copies string tokens byte-for-byte, so an existing `\/` escape stays
    // `\/`. `JSON.stringify(JSON.parse(...))` would instead re-escape the decoded `/` using its
    // own (unescaped) convention, changing the payload's exact bytes.
    const raw = '{"path":"a\\/b"}';
    expect(legacyFormatDebugJson(raw)).toBe('{\n  "path": "a\\/b"\n}');
  });

  test("matches Go's json.Indent shape for nested objects/arrays, including empty ones", () => {
    const raw = '{"a":1,"b":{"c":2,"d":[1,{"e":3}]},"empty":{},"emptyArr":[]}';
    expect(legacyFormatDebugJson(raw)).toBe(
      [
        "{",
        '  "a": 1,',
        '  "b": {',
        '    "c": 2,',
        '    "d": [',
        "      1,",
        "      {",
        '        "e": 3',
        "      }",
        "    ]",
        "  },",
        '  "empty": {},',
        '  "emptyArr": []',
        "}",
      ].join("\n"),
    );
  });
});
