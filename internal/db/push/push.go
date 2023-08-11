package push

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/apply"
	"github.com/supabase/cli/internal/migration/up"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, dryRun, ignoreVersionMismatch bool, includeRoles, includeSeed bool, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if dryRun {
		fmt.Fprintln(os.Stderr, "DRY RUN: migrations will *not* be pushed to the database.")
	}
	conn, err := utils.ConnectRemotePostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	// Create roles
	if !dryRun && includeRoles {
		if err := CreateCustomRoles(ctx, conn, os.Stderr, fsys); err != nil {
			return err
		}
	}
	pending, err := up.GetPendingMigrations(ctx, ignoreVersionMismatch, conn, fsys)
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
	// Seed database
	if !dryRun && includeSeed {
		if err := apply.SeedDatabase(ctx, conn, fsys); err != nil {
			return err
		}
	}
	fmt.Println("Finished " + utils.Aqua("supabase db push") + ".")
	return nil
}

func CreateCustomRoles(ctx context.Context, conn *pgx.Conn, w io.Writer, fsys afero.Fs) error {
	roles, err := fsys.Open(utils.CustomRolesPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	fmt.Fprintln(w, "Creating custom roles "+utils.Bold(utils.CustomRolesPath)+"...")
	return apply.BatchExecDDL(ctx, conn, roles)
}
