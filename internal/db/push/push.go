package push

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/apply"
	"github.com/supabase/cli/internal/migration/up"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

func Run(ctx context.Context, dryRun, ignoreVersionMismatch bool, includeRoles, includeSeed bool, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if dryRun {
		fmt.Fprintln(os.Stderr, "DRY RUN: migrations will *not* be pushed to the database.")
	}
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	pending, err := up.GetPendingMigrations(ctx, ignoreVersionMismatch, conn, fsys)
	if err != nil {
		return err
	}
	if len(pending) == 0 {
		fmt.Println("Remote database is up to date.")
		return nil
	}
	// Push pending migrations
	if dryRun {
		if includeRoles {
			fmt.Fprintln(os.Stderr, "Would create custom roles "+utils.Bold(utils.CustomRolesPath)+"...")
		}
		fmt.Fprintln(os.Stderr, "Would push these migrations:")
		fmt.Fprint(os.Stderr, utils.Bold(confirmPushAll(pending)))
		if includeSeed {
			fmt.Fprintln(os.Stderr, "Would seed data "+utils.Bold(utils.DefaultSeedDataPath)+"...")
		}
	} else {
		msg := fmt.Sprintf("Do you want to push these migrations to the remote database?\n%s\n", confirmPushAll(pending))
		if shouldPush, err := utils.NewConsole().PromptYesNo(ctx, msg, true); err != nil {
			return err
		} else if !shouldPush {
			return errors.New(context.Canceled)
		}
		if includeRoles {
			if err := apply.CreateCustomRoles(ctx, conn, fsys); err != nil {
				return err
			}
		}
		if err := migration.ApplyMigrations(ctx, pending, conn, afero.NewIOFS(fsys)); err != nil {
			return err
		}
		if includeSeed {
			if err := apply.SeedDatabase(ctx, conn, fsys); err != nil {
				return err
			}
		}
	}
	fmt.Println("Finished " + utils.Aqua("supabase db push") + ".")
	return nil
}

func confirmPushAll(pending []string) (msg string) {
	for _, path := range pending {
		filename := filepath.Base(path)
		msg += fmt.Sprintf(" • %s\n", filename)
	}
	return msg
}
