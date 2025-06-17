package inspect

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	_ "github.com/mithrandie/csvq-driver"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
)

//go:embed **/*.sql
var queries embed.FS

func Report(ctx context.Context, outDir string, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if !filepath.IsAbs(outDir) {
		outDir = filepath.Join(utils.CurrentDirAbs, outDir)
	}
	outDir = filepath.Join(outDir, time.Now().Format("2006-01-02"))
	if err := utils.MkdirIfNotExistFS(fsys, outDir); err != nil {
		return err
	}
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	fmt.Fprintln(os.Stderr, "Running queries...")
	if err := fs.WalkDir(queries, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return errors.Errorf("failed to walk queries: %w", err)
		}
		if d.IsDir() {
			return nil
		}
		query, err := queries.ReadFile(path)
		if err != nil {
			return errors.Errorf("failed to read query: %w", err)
		}
		name := strings.Split(d.Name(), ".")[0]
		outPath := filepath.Join(outDir, fmt.Sprintf("%s.csv", name))
		return copyToCSV(ctx, string(query), outPath, conn.PgConn(), fsys)
	}); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Reports saved to "+utils.Bold(outDir))
	return printReportSummary(outDir, fsys)
}

func copyToCSV(ctx context.Context, query, outPath string, conn *pgconn.PgConn, fsys afero.Fs) error {
	// Create output file
	f, err := fsys.OpenFile(outPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return errors.Errorf("failed to create output file: %w", err)
	}
	defer f.Close()
	// Execute query
	csvQuery := wrapQuery(query)
	if _, err = conn.CopyTo(ctx, f, csvQuery); err != nil {
		return errors.Errorf("failed to copy output: %w", err)
	}
	return nil
}

var ignoreSchemas = fmt.Sprintf("'{%s}'::text[]", strings.Join(reset.LikeEscapeSchema(utils.InternalSchemas), ","))

func wrapQuery(query string) string {
	fullQuery := strings.ReplaceAll(query, "$1", ignoreSchemas)
	fullQuery = strings.ReplaceAll(fullQuery, "$2", "'postgres'")
	return fmt.Sprintf("COPY (%s) TO STDOUT WITH CSV HEADER", fullQuery)
}

// Rule defines a validation rule for a CSV file
type Rule struct {
	Query string `toml:"query"`
	Name  string `toml:"name"`
	Pass  string `toml:"pass"`
	Fail  string `toml:"fail"`
}

// Config holds all rules
type Config struct {
	Rules []Rule `toml:"rule"`
}

//go:embed templates/rules.toml
var rulesConfig embed.FS

func printReportSummary(dateDir string, fsys afero.Fs) error {
	var cfg Config
	rulesPath := filepath.Join("tools", "inspect_rules.toml")
	if _, err := toml.DecodeFS(afero.NewIOFS(fsys), rulesPath, &cfg); errors.Is(err, os.ErrNotExist) {
		if _, err := toml.DecodeFS(rulesConfig, "templates/rules.toml", &cfg); err != nil {
			return errors.Errorf("failed load default rules: %w", err)
		}
	} else if err != nil {
		return errors.Errorf("failed to parse inspect rules: %w", err)
	}

	// Open csvq database rooted at the output directory
	db, err := sql.Open("csvq", dateDir)
	if err != nil {
		return err
	}
	defer db.Close()

	// Build report summary table
	table := "RULE|STATUS|MATCHES\n|-|-|-|\n"

	// find matching rule
	var status string
	for _, r := range cfg.Rules {
		row := db.QueryRow(r.Query)
		var match sql.NullString

		if err := row.Scan(&match); err != nil {
			if err == sql.ErrNoRows {
				status = r.Pass
			} else {
				status = err.Error()
			}
		} else {
			if !match.Valid || match.String == "" {
				status = r.Pass
			} else {
				status = r.Fail
			}
		}
		matchStr := "-"
		if match.Valid {
			matchStr = match.String
		}
		table += fmt.Sprintf("|`%s`|`%s`|`%s`|\n", r.Name, status, matchStr)
	}
	return list.RenderTable(table)
}
