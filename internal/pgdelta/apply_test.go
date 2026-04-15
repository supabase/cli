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

	formatted := formatApplyFailure(result)
	assertContains(t, formatted, `pg-delta apply returned status "stuck"`)
	assertContains(t, formatted, `29/34 statements applied in 2 round(s)`)
	assertContains(t, formatted, `cluster/extensions/pgmq.sql:0 [CREATE_EXTENSION]`)
	assertContains(t, formatted, `schema "pgmq" does not exist (SQLSTATE 3F000, dependency error)`)
	assertContains(t, formatted, `SQL: CREATE EXTENSION pgmq WITH SCHEMA pgmq;`)
}

func assertContains(t *testing.T, text, want string) {
	t.Helper()
	if !strings.Contains(text, want) {
		t.Fatalf("expected %q to contain %q", text, want)
	}
}
