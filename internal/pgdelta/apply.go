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
	// ValidationErrors captures failures from pg-delta's final
	// check_function_bodies=on pass. They are reported even when all
	// statements applied cleanly, so must be surfaced explicitly.
	ValidationErrors []ApplyIssue     `json:"validationErrors,omitempty"`
	Diagnostics      []ApplyDiagnosis `json:"diagnostics,omitempty"`
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
	Position          int             `json:"position,omitempty"`
	Detail            string          `json:"detail,omitempty"`
	Hint              string          `json:"hint,omitempty"`
}

// ApplyDiagnosis mirrors pg-topo's Diagnostic entries: static-analysis
// warnings that are surfaced alongside the apply result but don't cause
// failure on their own. Shape must stay in sync with the pg-topo package.
//
// UnmarshalJSON is implemented defensively so new or changed fields in
// pg-topo's Diagnostic do not break the whole apply result parse. Losing a
// diagnostic here would also swallow validationErrors and stuckStatements,
// leaving the user with a useless "failed to parse pg-delta apply output"
// message instead of the actual SQL error.
type ApplyDiagnosis struct {
	Code         string                  `json:"code,omitempty"`
	Message      string                  `json:"message,omitempty"`
	StatementID  *ApplyStatementLocation `json:"statementId,omitempty"`
	SuggestedFix string                  `json:"suggestedFix,omitempty"`
}

// ApplyStatementLocation matches pg-topo's StatementId shape.
type ApplyStatementLocation struct {
	FilePath       string `json:"filePath,omitempty"`
	StatementIndex int    `json:"statementIndex,omitempty"`
	SourceOffset   int    `json:"sourceOffset,omitempty"`
}

func (d *ApplyDiagnosis) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if bytes.Equal(trimmed, []byte("null")) {
		*d = ApplyDiagnosis{}
		return nil
	}
	// Unmarshal into a shadow type first so an unexpected statementId shape
	// (string, missing fields, future additions) degrades gracefully instead
	// of aborting the whole ApplyResult parse.
	var raw struct {
		Code         string          `json:"code"`
		Message      string          `json:"message"`
		StatementID  json.RawMessage `json:"statementId"`
		SuggestedFix string          `json:"suggestedFix"`
	}
	if err := json.Unmarshal(trimmed, &raw); err != nil {
		return err
	}
	d.Code = raw.Code
	d.Message = raw.Message
	d.SuggestedFix = raw.SuggestedFix
	if len(bytes.TrimSpace(raw.StatementID)) == 0 || bytes.Equal(bytes.TrimSpace(raw.StatementID), []byte("null")) {
		d.StatementID = nil
		return nil
	}
	var loc ApplyStatementLocation
	if err := json.Unmarshal(raw.StatementID, &loc); err == nil {
		d.StatementID = &loc
		return nil
	}
	// Fallback: accept a bare string (older pg-topo revisions) so we keep
	// something printable instead of dropping the diagnostic entirely.
	var asString string
	if err := json.Unmarshal(raw.StatementID, &asString); err == nil {
		d.StatementID = &ApplyStatementLocation{FilePath: asString}
	}
	return nil
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

// formatApplyFailure renders a human-readable summary of an unsuccessful
// pg-delta apply result. When verbose is false (the default CLI output),
// pg-topo diagnostics are collapsed to a single-line summary because they are
// static-analysis warnings – not fatal errors – and can number in the
// hundreds for large schemas. Passing verbose=true (set by --debug) expands
// them to the full per-diagnostic listing.
func formatApplyFailure(result ApplyResult, verbose bool) string {
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
	if len(result.ValidationErrors) > 0 {
		lines = append(lines, "Validation errors (from check_function_bodies=on pass):")
		for _, issue := range result.ValidationErrors {
			lines = append(lines, formatApplyIssue(issue))
		}
	}
	if len(result.Diagnostics) > 0 {
		if verbose {
			lines = append(lines, "Diagnostics:")
			for _, d := range result.Diagnostics {
				lines = append(lines, formatApplyDiagnosis(d))
			}
		} else {
			lines = append(lines, fmt.Sprintf("%d pg-topo diagnostic(s) omitted (re-run with --debug to view).", len(result.Diagnostics)))
		}
	}
	// pg-delta may report status "error" without populating any issue arrays
	// (e.g. an internal assertion in a future pg-delta release). Tell the user
	// how to collect more information rather than leaving them with just the
	// bare status line.
	if len(result.Errors) == 0 && len(result.StuckStatements) == 0 && len(result.ValidationErrors) == 0 {
		lines = append(lines,
			"No per-statement diagnostics were reported by pg-delta.",
			"Re-run with --debug to print the raw pg-delta payload, or open an issue at",
			"https://github.com/supabase/pg-toolbelt/issues with the debug bundle attached.",
		)
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
	if detail := strings.TrimSpace(issue.Detail); detail != "" {
		lines = append(lines, "  Detail: "+detail)
	}
	if hint := strings.TrimSpace(issue.Hint); hint != "" {
		lines = append(lines, "  Hint: "+hint)
	}
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
	if issue.Position > 0 {
		metadata = append(metadata, fmt.Sprintf("position %d", issue.Position))
	}
	if issue.IsDependencyError {
		metadata = append(metadata, "dependency error")
	}
	if len(metadata) == 0 {
		return message
	}
	return fmt.Sprintf("%s (%s)", message, strings.Join(metadata, ", "))
}

func formatApplyDiagnosis(d ApplyDiagnosis) string {
	message := strings.TrimSpace(d.Message)
	if message == "" {
		message = "unknown pg-delta diagnostic"
	}
	parts := []string{"- "}
	if code := strings.TrimSpace(d.Code); code != "" {
		parts = append(parts, "["+code+"] ")
	}
	parts = append(parts, message)
	if loc := formatStatementLocation(d.StatementID); loc != "" {
		parts = append(parts, " ("+loc+")")
	}
	if fix := strings.TrimSpace(d.SuggestedFix); fix != "" {
		parts = append(parts, "\n  Suggested fix: "+fix)
	}
	return strings.Join(parts, "")
}

func formatStatementLocation(loc *ApplyStatementLocation) string {
	if loc == nil {
		return ""
	}
	path := strings.TrimSpace(loc.FilePath)
	if path == "" {
		return ""
	}
	if loc.StatementIndex > 0 {
		return fmt.Sprintf("%s#%d", path, loc.StatementIndex)
	}
	return path
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
		// Always print the human-readable summary so failures are actionable
		// even when --debug is set. In debug mode the summary also expands
		// pg-topo diagnostics inline and we additionally dump the raw
		// pg-delta payload so users can forward it when reporting bugs.
		verbose := viper.GetBool("DEBUG")
		fmt.Fprintln(os.Stderr, formatApplyFailure(result, verbose))
		if verbose {
			if debugJSON := formatDebugJSON(stdout.Bytes()); len(debugJSON) > 0 {
				fmt.Fprintln(os.Stderr, "pg-delta apply result:")
				fmt.Fprintln(os.Stderr, debugJSON)
			}
		}
		return errors.Errorf("pg-delta declarative apply failed with status: %s", result.Status)
	}
	fmt.Fprintf(os.Stderr, "Applied %d statements in %d round(s).\n", result.TotalApplied, result.TotalRounds)
	return nil
}
