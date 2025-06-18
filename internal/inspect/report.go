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
	outDir = filepath.Join(outDir, time.Now().Format("2006-01-02"))
	if !filepath.IsAbs(outDir) {
		outDir = filepath.Join(utils.CurrentDirAbs, outDir)
	}
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
		return copyToCSV(ctx, string(query), config.Database, outPath, conn.PgConn(), fsys)
	}); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Reports saved to "+utils.Bold(outDir))
	return printSummary(ctx, outDir)
}

var ignoreSchemas = fmt.Sprintf("'{%s}'::text[]", strings.Join(reset.LikeEscapeSchema(utils.InternalSchemas), ","))

func copyToCSV(ctx context.Context, query, database, outPath string, conn *pgconn.PgConn, fsys afero.Fs) error {
	// Create output file
	f, err := fsys.OpenFile(outPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return errors.Errorf("failed to create output file: %w", err)
	}
	defer f.Close()
	// Execute query
	csvQuery := wrapQuery(query, ignoreSchemas, fmt.Sprintf("'%s'", database))
	if _, err = conn.CopyTo(ctx, f, csvQuery); err != nil {
		return errors.Errorf("failed to copy output: %w", err)
	}
	return nil
}

func wrapQuery(query string, args ...string) string {
	for i, v := range args {
		query = strings.ReplaceAll(query, fmt.Sprintf("$%d", i+1), v)
	}
	return fmt.Sprintf("COPY (%s) TO STDOUT WITH CSV HEADER", query)
}

//go:embed templates/rules.toml
var rulesConfig embed.FS

func printSummary(ctx context.Context, outDir string) error {
	if len(utils.Config.Experimental.Inspect.Rules) == 0 {
		fmt.Fprintln(os.Stderr, "Loading default rules...")
		if _, err := toml.DecodeFS(rulesConfig, "templates/rules.toml", &utils.Config.Experimental.Inspect); err != nil {
			return errors.Errorf("failed load default rules: %w", err)
		}
	}
	// Open csvq database rooted at the output directory
	db, err := sql.Open("csvq", outDir)
	if err != nil {
		return err
	}
	defer db.Close()
	// Build report summary table
	table := "RULE|STATUS|MATCHES\n|-|-|-|\n"
	for _, r := range utils.Config.Experimental.Inspect.Rules {
		row := db.QueryRowContext(ctx, r.Query)
		// find matching rule
		var status string
		var match sql.NullString
		if err := row.Scan(&match); errors.Is(err, sql.ErrNoRows) {
			status = r.Pass
		} else if err != nil {
			status = err.Error()
		} else if !match.Valid || match.String == "" {
			status = r.Pass
		} else {
			status = r.Fail
		}
		if !match.Valid {
			match.String = "-"
		}
		table += fmt.Sprintf("|`%s`|`%s`|`%s`|\n", r.Name, status, match.String)
	}
	return list.RenderTable(table)
}
