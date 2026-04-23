package pgdelta

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
)

//go:embed templates/pgdelta_declarative_apply.ts
var pgDeltaDeclarativeApplyScript string

// ApplyResult models the JSON payload emitted by pgdelta_declarative_apply.ts.
//
// The fields are surfaced to provide concise CLI feedback after apply runs.
type ApplyResult struct {
	Status          string       `json:"status"`
	TotalStatements int          `json:"totalStatements"`
	TotalRounds     int          `json:"totalRounds"`
	TotalApplied    int          `json:"totalApplied"`
	TotalSkipped    int          `json:"totalSkipped"`
	Errors          []ApplyIssue `json:"errors"`
	StuckStatements []ApplyIssue `json:"stuckStatements"`
}

// ApplyIssue models a pg-delta apply error or stuck statement.
//
// pg-delta may emit either a plain string or a structured object, so unmarshal
// needs to gracefully handle both forms.
type ApplyIssue struct {
	Statement         *ApplyStatement `json:"statement,omitempty"`
	Code              string          `json:"code,omitempty"`
	Message           string          `json:"message,omitempty"`
	IsDependencyError bool            `json:"isDependencyError,omitempty"`
}

type ApplyStatement struct {
	ID             string `json:"id"`
	SQL            string `json:"sql"`
	StatementClass string `json:"statementClass"`
}

func (i *ApplyIssue) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if bytes.Equal(trimmed, []byte("null")) {
		*i = ApplyIssue{}
		return nil
	}
	var message string
	if err := json.Unmarshal(trimmed, &message); err == nil {
		*i = ApplyIssue{Message: message}
		return nil
	}
	type alias ApplyIssue
	var parsed alias
	if err := json.Unmarshal(trimmed, &parsed); err != nil {
		return err
	}
	*i = ApplyIssue(parsed)
	return nil
}

func formatApplyFailure(result ApplyResult) string {
	totalStatements := result.TotalStatements
	if totalStatements == 0 {
		totalStatements = result.TotalApplied + result.TotalSkipped + len(result.StuckStatements)
	}
	lines := []string{
		fmt.Sprintf("pg-delta apply returned status %q.", result.Status),
		fmt.Sprintf("%d/%d statements applied in %d round(s); %d skipped.", result.TotalApplied, totalStatements, result.TotalRounds, result.TotalSkipped),
	}
	if len(result.Errors) > 0 {
		lines = append(lines, "Errors:")
		for _, issue := range result.Errors {
			lines = append(lines, formatApplyIssue(issue))
		}
	}
	if len(result.StuckStatements) > 0 {
		lines = append(lines, "Stuck statements:")
		for _, issue := range result.StuckStatements {
			lines = append(lines, formatApplyIssue(issue))
		}
	}
	return strings.Join(lines, "\n")
}

func formatApplyIssue(issue ApplyIssue) string {
	if issue.Statement == nil {
		return "- " + formatApplyIssueMessage(issue)
	}
	title := "- " + issue.Statement.ID
	if issue.Statement.StatementClass != "" {
		title += " [" + issue.Statement.StatementClass + "]"
	}
	lines := []string{title}
	lines = append(lines, "  "+formatApplyIssueMessage(issue))
	if sql := formatStatementSQL(issue.Statement.SQL); sql != "" {
		lines = append(lines, "  SQL: "+sql)
	}
	return strings.Join(lines, "\n")
}

func formatApplyIssueMessage(issue ApplyIssue) string {
	message := strings.TrimSpace(issue.Message)
	if message == "" {
		message = "unknown pg-delta issue"
	}
	var metadata []string
	if issue.Code != "" {
		metadata = append(metadata, "SQLSTATE "+issue.Code)
	}
	if issue.IsDependencyError {
		metadata = append(metadata, "dependency error")
	}
	if len(metadata) == 0 {
		return message
	}
	return fmt.Sprintf("%s (%s)", message, strings.Join(metadata, ", "))
}

func formatStatementSQL(sql string) string {
	normalized := strings.Join(strings.Fields(sql), " ")
	const maxLen = 120
	if len(normalized) <= maxLen {
		return normalized
	}
	return normalized[:maxLen-3] + "..."
}

func formatDebugJSON(raw []byte) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return ""
	}
	var indented bytes.Buffer
	if err := json.Indent(&indented, trimmed, "", "  "); err == nil {
		return indented.String()
	}
	return string(trimmed)
}

// ApplyDeclarative applies files from supabase/declarative to the target
// database using pg-delta's declarative apply engine.
//
// This is intentionally separate from migration apply so declarative workflows
// can evolve independently from timestamped migration execution.
func ApplyDeclarative(ctx context.Context, config pgconn.Config, fsys afero.Fs) error {
	declarativeDir := utils.GetDeclarativeDir()
	if _, err := fsys.Stat(declarativeDir); err != nil {
		return errors.Errorf("declarative schema directory not found: %s", declarativeDir)
	}
	absDir, err := filepath.Abs(declarativeDir)
	if err != nil {
		return errors.Errorf("failed to resolve declarative dir: %w", err)
	}

	const containerSchemaPath = "/declarative"
	env := []string{
		"SCHEMA_PATH=" + containerSchemaPath,
		"TARGET=" + utils.ToPostgresURL(config),
	}
	binds := []string{
		utils.EdgeRuntimeId + ":/root/.cache/deno:rw",
		absDir + ":" + containerSchemaPath + ":ro",
	}

	fmt.Fprintln(os.Stderr, "Applying declarative schemas via pg-delta...")
	var stdout, stderr bytes.Buffer
	if err := utils.RunEdgeRuntimeScript(ctx, env, pgDeltaDeclarativeApplyScript, binds, "error running pg-delta script", &stdout, &stderr); err != nil {
		return err
	}

	var result ApplyResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		if viper.GetBool("DEBUG") {
			return errors.Errorf("failed to parse pg-delta apply output: %w\nstdout: %s", err, stdout.String())
		}
		return errors.Errorf("failed to parse pg-delta apply output: %w", err)
	}
	if result.Status != "success" {
		if viper.GetBool("DEBUG") {
			if debugJSON := formatDebugJSON(stdout.Bytes()); len(debugJSON) > 0 {
				fmt.Fprintln(os.Stderr, "pg-delta apply result:")
				fmt.Fprintln(os.Stderr, debugJSON)
			}
		} else {
			fmt.Fprintln(os.Stderr, formatApplyFailure(result))
		}
		return errors.Errorf("pg-delta declarative apply failed with status: %s", result.Status)
	}
	fmt.Fprintf(os.Stderr, "Applied %d statements in %d round(s).\n", result.TotalApplied, result.TotalRounds)
	return nil
}
