package inspect

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/utils"
)

//go:embed **/*.sql
var queries embed.FS

func Report(ctx context.Context, out string, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	date := time.Now().Format("2006-01-02")
	if err := utils.MkdirIfNotExistFS(fsys, out); err != nil {
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
		outPath := filepath.Join(out, fmt.Sprintf("%s_%s.csv", name, date))
		return copyToCSV(ctx, string(query), outPath, conn.PgConn(), fsys)
	}); err != nil {
		return err
	}
	if !filepath.IsAbs(out) {
		out, _ = filepath.Abs(out)
	}
	fmt.Fprintln(os.Stderr, "Reports saved to "+utils.Bold(out))
	return nil
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
	return fmt.Sprintf("COPY (%s) TO STDOUT WITH CSV HEADER", fullQuery)
}
