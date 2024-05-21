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

const ROOT_DIR = "queries/"
const CSV_QUERY = `COPY (%s) TO STDOUT WITH CSV HEADER`

//go:embed **/*.sql
var queries embed.FS

func ReadQuery(query string) string {
	path := fmt.Sprintf("%s%s.sql", ROOT_DIR, query)
	queryString, err := queries.ReadFile(path)
	if err != nil {
		println(err.Error())
		return ""
	}
	return string(queryString)
}

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
		name := strings.Split(d.Name(), ".")[0]
		outPath := filepath.Join(out, fmt.Sprintf("%s_%s.csv", name, date))
		return copyToCSV(ctx, path, outPath, conn.PgConn(), fsys)
	}); err != nil {
		return err
	}
	if !filepath.IsAbs(out) {
		out, _ = filepath.Abs(out)
	}
	fmt.Fprintln(os.Stderr, "Reports saved to "+utils.Bold(out))
	return nil
}

func copyToCSV(ctx context.Context, srcPath, outPath string, conn *pgconn.PgConn, fsys afero.Fs) error {
	// Prepare SQL query
	rawQuery, err := queries.ReadFile(srcPath)
	if err != nil {
		return errors.Errorf("failed to read query: %w", err)
	}
	placeholder := fmt.Sprintf("'{%s}'::text[]", strings.Join(reset.LikeEscapeSchema(utils.InternalSchemas), ","))
	fullQuery := strings.ReplaceAll(string(rawQuery), "$1", placeholder)
	csvQuery := fmt.Sprintf("COPY (%s) TO STDOUT WITH CSV HEADER", fullQuery)
	// Create output file
	f, err := fsys.OpenFile(outPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return errors.Errorf("failed to create output file: %w", err)
	}
	defer f.Close()
	if _, err = conn.CopyTo(ctx, f, csvQuery); err != nil {
		return errors.Errorf("failed to copy output: %w", err)
	}
	return nil
}
