package lint

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/debug"
	"github.com/supabase/cli/internal/utils"
)

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
		if curr == level {
			return LintLevel(i)
		}
	}
	return -1
}

func Run(ctx context.Context, schema []string, level string, stdout io.Writer, fsys afero.Fs, opts ...func(*pgx.ConnConfig)) error {
	// Sanity checks.
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	if err := utils.AssertSupabaseDbIsRunning(); err != nil {
		return err
	}
	// Run lint script
	conn, err := ConnectLocalPostgres(ctx, "localhost", utils.Config.Db.Port, "postgres", opts...)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	result, err := LintDatabase(ctx, conn, schema)
	if err != nil {
		return err
	}
	filtered := filterResult(result, toEnum(level))
	// Print output
	if len(filtered) == 0 {
		return nil
	}
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(filtered); err != nil {
		return err
	}
	return nil
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

// Connnect to local Postgres with optimised settings. The caller is responsible for closing the connection returned.
func ConnectLocalPostgres(ctx context.Context, host string, port uint, database string, options ...func(*pgx.ConnConfig)) (*pgx.Conn, error) {
	url := fmt.Sprintf("postgresql://postgres:postgres@%s:%d/%s", host, port, database)
	// Parse connection url
	config, err := pgx.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	// Apply config overrides
	for _, op := range options {
		op(config)
	}
	if viper.GetBool("DEBUG") {
		debug.SetupPGX(config)
	}
	// Connect to database
	return pgx.ConnectConfig(ctx, config)
}

func LintDatabase(ctx context.Context, conn *pgx.Conn, schema []string) ([]Result, error) {
	tx, err := conn.Begin(ctx)
	if err != nil {
		return nil, err
	}
	// Always rollback since lint should not have side effects
	defer tx.Rollback(context.Background())
	enable := "CREATE EXTENSION IF NOT EXISTS plpgsql_check"
	if _, err := conn.Exec(ctx, enable); err != nil {
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
		for rows.Next() {
			data := rows.RawValues()
			r, err := toResult(data)
			if err != nil {
				return nil, err
			}
			r.Function = s + "." + r.Function
			result = append(result, r)
		}
		err = rows.Err()
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

func toResult(data [][]byte) (Result, error) {
	var result Result
	name := string(data[0])
	if err := json.Unmarshal(data[1], &result); err != nil {
		return result, err
	}
	result.Function = name
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
	Level     string    `json:"level"`
	Message   string    `json:"message"`
	Statement Statement `json:"statement,omitempty"`
	Query     Query     `json:"query,omitempty"`
	Hint      string    `json:"hint,omitempty"`
	Detail    string    `json:"detail,omitempty"`
	Context   string    `json:"context,omitempty"`
	SQLState  string    `json:"sqlState,omitempty"`
}

type Result struct {
	Function string  `json:"function"`
	Issues   []Issue `json:"issues"`
}
