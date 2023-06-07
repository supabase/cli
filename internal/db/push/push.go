package push

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/apply"
	"github.com/supabase/cli/internal/migration/up"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, dryRun bool, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if dryRun {
		fmt.Fprintln(os.Stderr, "DRY RUN: migrations will *not* be pushed to the database.")
	}
	conn, err := utils.ConnectRemotePostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	pending, err := up.GetPendingMigrations(ctx, conn, fsys)
	if err != nil {
		return err
	}
	if len(pending) == 0 {
		fmt.Println("Linked project is up to date.")
		return nil
	}
	// Push pending migrations
	if dryRun {
		for _, filename := range pending {
			fmt.Fprintln(os.Stderr, "Would push migration "+utils.Bold(filename)+"...")
		}
	} else {
		if err := apply.MigrateUp(ctx, conn, pending, fsys); err != nil {
			return err
		}
	}
	fmt.Println("Finished " + utils.Aqua("supabase db push") + ".")
	return nil
}
