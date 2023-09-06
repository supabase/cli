package lint

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/utils"
)

const ENABLE_PGSQL_CHECK = "CREATE EXTENSION IF NOT EXISTS plpgsql_check"

var (
	AllowedLevels = []string{
		"warning",
		"error",
	}
	//go:embed templates/check.sql
	checkSchemaScript string
)

type LintLevel int

func toEnum(level string) LintLevel {
	for i, curr := range AllowedLevels {
		if strings.HasPrefix(level, curr) {
			return LintLevel(i)
		}
	}
	return -1
}

func Run(ctx context.Context, schema []string, level string, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// Sanity checks.
	conn, err := connect(ctx, config, fsys, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	// Run lint script
	result, err := LintDatabase(ctx, conn, schema)
	if err != nil {
		return err
	}
	if len(result) == 0 {
		fmt.Fprintln(os.Stderr, "\nNo schema errors found")
		return nil
	}
	return printResultJSON(result, toEnum(level), os.Stdout)
}

func connect(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (*pgx.Conn, error) {
	if config.Host != "localhost" {
		fmt.Fprintln(os.Stderr, "Connecting to remote database...")
		return utils.ConnectRemotePostgres(ctx, config, options...)
	}
	fmt.Fprintln(os.Stderr, "Connecting to local database...")
	if err := utils.LoadConfigFS(fsys); err != nil {
		return nil, err
	}
	if err := utils.AssertSupabaseDbIsRunning(); err != nil {
		return nil, err
	}
	return utils.ConnectLocalPostgres(ctx, pgconn.Config{}, options...)
}

func filterResult(result []Result, minLevel LintLevel) (filtered []Result) {
	for _, r := range result {
		out := Result{Function: r.Function}
		for _, issue := range r.Issues {
			if toEnum(issue.Level) >= minLevel {
				out.Issues = append(out.Issues, issue)
			}
		}
		if len(out.Issues) > 0 {
			filtered = append(filtered, out)
		}
	}
	return filtered
}

func printResultJSON(result []Result, minLevel LintLevel, stdout io.Writer) error {
	filtered := filterResult(result, minLevel)
	if len(filtered) == 0 {
		return nil
	}
	// Pretty print output
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(filtered)
}

func LintDatabase(ctx context.Context, conn *pgx.Conn, schema []string) ([]Result, error) {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if len(schema) == 0 {
		schema, err = diff.LoadUserSchemas(ctx, conn, utils.InternalSchemas...)
		if err != nil {
			return nil, err
		}
	}
	// Always rollback since lint should not have side effects
	defer func() {
		if err := tx.Rollback(context.Background()); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	if _, err := conn.Exec(ctx, ENABLE_PGSQL_CHECK); err != nil {
		return nil, err
	}
	// Batch prepares statements
	batch := pgx.Batch{}
	for _, s := range schema {
		batch.Queue(checkSchemaScript, s)
	}
	br := conn.SendBatch(ctx, &batch)
	defer br.Close()
	var result []Result
	for _, s := range schema {
		fmt.Fprintln(os.Stderr, "Linting schema:", s)
		rows, err := br.Query()
		if err != nil {
			return nil, err
		}
		// Parse result row
		for rows.Next() {
			var name string
			var data []byte
			if err := rows.Scan(&name, &data); err != nil {
				return nil, err
			}
			var r Result
			if err := json.Unmarshal(data, &r); err != nil {
				return nil, err
			}
			// Update function name
			r.Function = s + "." + name
			result = append(result, r)
		}
		err = rows.Err()
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

type Query struct {
	Position string `json:"position"`
	Text     string `json:"text"`
}

type Statement struct {
	LineNumber string `json:"lineNumber"`
	Text       string `json:"text"`
}

type Issue struct {
	Level     string     `json:"level"`
	Message   string     `json:"message"`
	Statement *Statement `json:"statement,omitempty"`
	Query     *Query     `json:"query,omitempty"`
	Hint      string     `json:"hint,omitempty"`
	Detail    string     `json:"detail,omitempty"`
	Context   string     `json:"context,omitempty"`
	SQLState  string     `json:"sqlState,omitempty"`
}

type Result struct {
	Function string  `json:"function"`
	Issues   []Issue `json:"issues"`
}
