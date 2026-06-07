package pgdelta

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestApplyResultUnmarshalStructuredStuckStatements(t *testing.T) {
	raw := []byte(`{
		"status": "stuck",
		"totalStatements": 34,
		"totalRounds": 2,
		"totalApplied": 29,
		"totalSkipped": 0,
		"errors": [],
		"stuckStatements": [
			{
				"statement": {
					"id": "cluster/extensions/pgmq.sql:0",
					"sql": "CREATE EXTENSION pgmq WITH SCHEMA pgmq;",
					"statementClass": "CREATE_EXTENSION"
				},
				"code": "3F000",
				"message": "schema \"pgmq\" does not exist",
				"isDependencyError": true
			}
		]
	}`)

	var result ApplyResult
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}

	if got, want := len(result.StuckStatements), 1; got != want {
		t.Fatalf("len(StuckStatements) = %d, want %d", got, want)
	}

	stuck := result.StuckStatements[0]
	if stuck.Statement == nil {
		t.Fatal("expected structured statement details")
	}
	if got, want := stuck.Statement.ID, "cluster/extensions/pgmq.sql:0"; got != want {
		t.Fatalf("Statement.ID = %q, want %q", got, want)
	}
	if got, want := stuck.Statement.StatementClass, "CREATE_EXTENSION"; got != want {
		t.Fatalf("Statement.StatementClass = %q, want %q", got, want)
	}
	if got, want := stuck.Code, "3F000"; got != want {
		t.Fatalf("Code = %q, want %q", got, want)
	}
	if got, want := stuck.Message, `schema "pgmq" does not exist`; got != want {
		t.Fatalf("Message = %q, want %q", got, want)
	}
	if !stuck.IsDependencyError {
		t.Fatal("expected dependency error to be preserved")
	}
}

func TestFormatApplyFailure(t *testing.T) {
	result := ApplyResult{
		Status:          "stuck",
		TotalStatements: 34,
		TotalRounds:     2,
		TotalApplied:    29,
		TotalSkipped:    0,
		StuckStatements: []ApplyIssue{
			{
				Statement: &ApplyStatement{
					ID:             "cluster/extensions/pgmq.sql:0",
					SQL:            "CREATE EXTENSION pgmq WITH SCHEMA pgmq;",
					StatementClass: "CREATE_EXTENSION",
				},
				Code:              "3F000",
				Message:           `schema "pgmq" does not exist`,
				IsDependencyError: true,
			},
		},
	}

	formatted := formatApplyFailure(result, false)
	assertContains(t, formatted, `pg-delta apply returned status "stuck"`)
	assertContains(t, formatted, `29/34 statements applied in 2 round(s)`)
	assertContains(t, formatted, `cluster/extensions/pgmq.sql:0 [CREATE_EXTENSION]`)
	assertContains(t, formatted, `schema "pgmq" does not exist (SQLSTATE 3F000, dependency error)`)
	assertContains(t, formatted, `SQL: CREATE EXTENSION pgmq WITH SCHEMA pgmq;`)
}

// TestApplyResultUnmarshalValidationErrors reproduces the payload shape pg-delta
// emits when the final check_function_bodies=on pass fails: totalApplied
// matches totalStatements, errors and stuckStatements are empty, but status is
// "error" because validationErrors is non-empty.
func TestApplyResultUnmarshalValidationErrors(t *testing.T) {
	raw := []byte(`{
		"status": "error",
		"totalStatements": 1633,
		"totalRounds": 1,
		"totalApplied": 1633,
		"totalSkipped": 0,
		"errors": [],
		"stuckStatements": [],
		"validationErrors": [
			{
				"statement": {
					"id": "public/functions/my_function.sql:0",
					"sql": "CREATE FUNCTION public.my_function() RETURNS integer LANGUAGE sql AS $$ SELECT missing_column FROM users $$;",
					"statementClass": "CREATE_FUNCTION"
				},
				"code": "42703",
				"message": "column \"missing_column\" does not exist",
				"isDependencyError": false,
				"position": 8,
				"hint": "Perhaps you meant to reference the column \"users.missing_column_renamed\"."
			}
		]
	}`)

	var result ApplyResult
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}

	if got, want := len(result.ValidationErrors), 1; got != want {
		t.Fatalf("len(ValidationErrors) = %d, want %d", got, want)
	}

	issue := result.ValidationErrors[0]
	if issue.Statement == nil {
		t.Fatal("expected structured statement details")
	}
	if got, want := issue.Statement.ID, "public/functions/my_function.sql:0"; got != want {
		t.Fatalf("Statement.ID = %q, want %q", got, want)
	}
	if got, want := issue.Code, "42703"; got != want {
		t.Fatalf("Code = %q, want %q", got, want)
	}
	if got, want := issue.Position, 8; got != want {
		t.Fatalf("Position = %d, want %d", got, want)
	}
	if issue.Hint == "" {
		t.Fatal("expected Hint to be preserved")
	}
}

func TestFormatApplyFailureValidationErrors(t *testing.T) {
	result := ApplyResult{
		Status:          "error",
		TotalStatements: 1633,
		TotalRounds:     1,
		TotalApplied:    1633,
		TotalSkipped:    0,
		ValidationErrors: []ApplyIssue{
			{
				Statement: &ApplyStatement{
					ID:             "public/functions/my_function.sql:0",
					SQL:            "CREATE FUNCTION public.my_function() RETURNS integer LANGUAGE sql AS $$ SELECT missing_column FROM users $$;",
					StatementClass: "CREATE_FUNCTION",
				},
				Code:     "42703",
				Message:  `column "missing_column" does not exist`,
				Position: 8,
				Hint:     `Perhaps you meant to reference the column "users.missing_column_renamed".`,
			},
		},
	}

	formatted := formatApplyFailure(result, false)
	assertContains(t, formatted, `pg-delta apply returned status "error"`)
	assertContains(t, formatted, `1633/1633 statements applied in 1 round(s)`)
	assertContains(t, formatted, "Validation errors (from check_function_bodies=on pass):")
	assertContains(t, formatted, "public/functions/my_function.sql:0 [CREATE_FUNCTION]")
	assertContains(t, formatted, `column "missing_column" does not exist (SQLSTATE 42703, position 8)`)
	assertContains(t, formatted, "Hint: Perhaps you meant to reference the column")
}

// TestFormatApplyFailureNoDiagnostics exercises the fallback text we render
// when pg-delta returns status=error without any structured issues. The user
// originally reported seeing a bare error message in this situation.
func TestFormatApplyFailureNoDiagnostics(t *testing.T) {
	result := ApplyResult{
		Status:          "error",
		TotalStatements: 1633,
		TotalRounds:     1,
		TotalApplied:    1633,
		TotalSkipped:    0,
	}

	formatted := formatApplyFailure(result, false)
	assertContains(t, formatted, `pg-delta apply returned status "error"`)
	assertContains(t, formatted, "No per-statement diagnostics were reported by pg-delta")
	assertContains(t, formatted, "--debug")
}

// TestApplyResultUnmarshalRealWorldPayload covers the full shape pg-delta emits
// in practice, including diagnostics whose statementId is an object. Before we
// made ApplyDiagnosis.UnmarshalJSON defensive, this payload caused the entire
// result parse to fail with "cannot unmarshal object into Go struct field
// ApplyDiagnosis.diagnostics.statementId of type string", which in turn hid
// the real validation error from the user.
func TestApplyResultUnmarshalRealWorldPayload(t *testing.T) {
	raw := []byte(`{
		"status": "error",
		"totalStatements": 1625,
		"totalRounds": 1,
		"totalApplied": 1625,
		"totalSkipped": 0,
		"errors": [],
		"stuckStatements": [],
		"validationErrors": [
			{
				"statement": {
					"id": "schemas/public/functions/create_device.sql:0",
					"sql": "CREATE FUNCTION public.create_device () RETURNS void LANGUAGE plpgsql AS $function$BEGIN Invalid sql statement; END;$function$;",
					"statementClass": "CREATE_FUNCTION"
				},
				"code": "42601",
				"message": "syntax error at or near \"Invalid\"",
				"isDependencyError": false,
				"position": 541
			}
		],
		"diagnostics": [
			{
				"code": "UNRESOLVED_DEPENDENCY",
				"message": "No producer found for 'function:pgmq:delete:(unknown,unknown)'.",
				"statementId": {
					"filePath": "schemas/public/functions/pgmq_delete.sql",
					"statementIndex": 0,
					"sourceOffset": 0
				},
				"objectRefs": [
					{"kind": "function", "name": "delete", "schema": "pgmq", "signature": "(unknown,unknown)"}
				],
				"suggestedFix": "Add the missing statement to your SQL set or declare an explicit pg-topo annotation.",
				"details": {
					"requiredObjectKey": "function:pgmq:delete:(unknown,unknown)",
					"candidateObjectKeys": []
				}
			}
		]
	}`)

	var result ApplyResult
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}

	if got, want := len(result.ValidationErrors), 1; got != want {
		t.Fatalf("len(ValidationErrors) = %d, want %d", got, want)
	}
	if got, want := result.ValidationErrors[0].Message, `syntax error at or near "Invalid"`; got != want {
		t.Fatalf("ValidationErrors[0].Message = %q, want %q", got, want)
	}

	if got, want := len(result.Diagnostics), 1; got != want {
		t.Fatalf("len(Diagnostics) = %d, want %d", got, want)
	}
	diag := result.Diagnostics[0]
	if diag.StatementID == nil {
		t.Fatal("expected StatementID to be preserved as a structured location")
	}
	if got, want := diag.StatementID.FilePath, "schemas/public/functions/pgmq_delete.sql"; got != want {
		t.Fatalf("StatementID.FilePath = %q, want %q", got, want)
	}
	if got, want := diag.Code, "UNRESOLVED_DEPENDENCY"; got != want {
		t.Fatalf("Code = %q, want %q", got, want)
	}
	if diag.SuggestedFix == "" {
		t.Fatal("expected SuggestedFix to be preserved")
	}

	// Default (non-verbose) output collapses the diagnostics to a single line
	// so the user isn't flooded with pg-topo warnings on large schemas.
	formatted := formatApplyFailure(result, false)
	assertContains(t, formatted, "Validation errors (from check_function_bodies=on pass):")
	assertContains(t, formatted, "schemas/public/functions/create_device.sql:0 [CREATE_FUNCTION]")
	assertContains(t, formatted, `syntax error at or near "Invalid" (SQLSTATE 42601, position 541)`)
	assertContains(t, formatted, "1 pg-topo diagnostic(s) omitted (re-run with --debug to view).")
	assertNotContains(t, formatted, "[UNRESOLVED_DEPENDENCY]")

	// Verbose mode (triggered by --debug) expands the diagnostics inline.
	verbose := formatApplyFailure(result, true)
	assertContains(t, verbose, "Diagnostics:")
	assertContains(t, verbose, "[UNRESOLVED_DEPENDENCY]")
	assertContains(t, verbose, "schemas/public/functions/pgmq_delete.sql")
	assertNotContains(t, verbose, "pg-topo diagnostic(s) omitted")
}

// TestApplyDiagnosisFallbackStatementIdString covers the defensive path where
// pg-topo emits statementId as a string (older revisions) so the diagnostic
// still survives the parse.
func TestApplyDiagnosisFallbackStatementIdString(t *testing.T) {
	raw := []byte(`{
		"code": "LEGACY",
		"message": "legacy diagnostic shape",
		"statementId": "schemas/foo.sql:0"
	}`)

	var d ApplyDiagnosis
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if d.StatementID == nil {
		t.Fatal("expected StatementID to be populated from legacy string shape")
	}
	if got, want := d.StatementID.FilePath, "schemas/foo.sql:0"; got != want {
		t.Fatalf("StatementID.FilePath = %q, want %q", got, want)
	}
}

func assertContains(t *testing.T, text, want string) {
	t.Helper()
	if !strings.Contains(text, want) {
		t.Fatalf("expected %q to contain %q", text, want)
	}
}

func assertNotContains(t *testing.T, text, unwanted string) {
	t.Helper()
	if strings.Contains(text, unwanted) {
		t.Fatalf("expected %q to NOT contain %q", text, unwanted)
	}
}
