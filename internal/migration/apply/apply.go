package apply

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/parser"
)

func MigrateDatabase(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	migrations, err := list.LoadLocalMigrations(fsys)
	if err != nil {
		return err
	}
	// Apply migrations
	for _, filename := range migrations {
		if err := migrateUp(ctx, conn, filename, fsys); err != nil {
			return err
		}
	}
	return nil
}

func migrateUp(ctx context.Context, conn *pgx.Conn, filename string, fsys afero.Fs) error {
	fmt.Fprintln(os.Stderr, "Applying migration "+utils.Bold(filename)+"...")
	sql, err := fsys.Open(filepath.Join(utils.MigrationsDir, filename))
	if err != nil {
		return err
	}
	defer sql.Close()
	return BatchExecDDL(ctx, conn, sql)
}

func BatchExecDDL(ctx context.Context, conn *pgx.Conn, sql io.Reader) error {
	lines, err := parser.SplitAndTrim(sql)
	if err != nil {
		return err
	}
	// Batch migration commands, without using statement cache
	batch := pgconn.Batch{}
	for _, line := range lines {
		batch.ExecParams(line, nil, nil, nil, nil)
	}
	if result, err := conn.PgConn().ExecBatch(ctx, &batch).ReadAll(); err != nil {
		i := len(result)
		var stat string
		if i < len(lines) {
			stat = lines[i]
		}
		return fmt.Errorf("%v\nAt statement %d: %s", err, i, utils.Aqua(stat))
	}
	return nil
}
