package changes

import (
	"context"
	"io"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

var output string

func Run(ctx context.Context, schema []string, config pgconn.Config, fsys afero.Fs) error {
	// Sanity checks.
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}

	if err := utils.RunProgram(ctx, func(p utils.Program, ctx context.Context) error {
		return run(p, ctx, schema, config, fsys)
	}); err != nil {
		return err
	}

	return diff.SaveDiff(output, "", fsys)
}

func run(p utils.Program, ctx context.Context, schema []string, config pgconn.Config, fsys afero.Fs) (err error) {
	// 1. Assert `supabase/migrations` and `schema_migrations` are in sync.
	w := utils.StatusWriter{Program: p}
	if len(schema) == 0 {
		schema, err = loadSchema(ctx, config, w)
		if err != nil {
			return err
		}
	}

	// 2. Diff remote db (source) & shadow db (target) and print it.
	output, err = diff.DiffDatabase(ctx, schema, config, w, fsys, diff.DiffSchemaMigra)
	return err
}

func loadSchema(ctx context.Context, config pgconn.Config, w io.Writer) ([]string, error) {
	conn, err := utils.ConnectByConfigStream(ctx, config, w)
	if err != nil {
		return nil, err
	}
	defer conn.Close(context.Background())
	return migration.ListUserSchemas(ctx, conn)
}
