package changes

import (
	"context"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/utils"
)

var output string

func Run(ctx context.Context, schema []string, config pgconn.Config, fsys afero.Fs) error {
	// Sanity checks.
	{
		if err := utils.AssertDockerIsRunning(ctx); err != nil {
			return err
		}
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
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
	{
		p.Send(utils.StatusMsg("Connecting to remote database..."))
		conn, err := utils.ConnectRemotePostgres(ctx, config)
		if err != nil {
			return err
		}
		defer conn.Close(context.Background())
		if len(schema) == 0 {
			schema, err = diff.LoadUserSchemas(ctx, conn)
			if err != nil {
				return err
			}
		}
	}

	w := utils.StatusWriter{Program: p}
	// 2. Diff remote db (source) & shadow db (target) and print it.
	target := utils.ToPostgresURL(config)
	output, err = diff.DiffDatabase(ctx, schema, target, w, fsys)
	return err
}
