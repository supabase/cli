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
	"github.com/supabase/cli/internal/migration/up"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/migration"
	"github.com/supabase/cli/pkg/vault"
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
	var pending []string
	if !utils.Config.Db.Migrations.Enabled {
		fmt.Fprintln(os.Stderr, "Skipping migrations because it is disabled in config.toml for project:", flags.ProjectRef)
	} else if pending, err = up.GetPendingMigrations(ctx, ignoreVersionMismatch, conn, fsys); err != nil {
		return err
	}
	var seeds []migration.SeedFile
	if includeSeed {
		// TODO: flag should override config but we don't resolve glob paths when seed is disabled.
		if !utils.Config.Db.Seed.Enabled {
			fmt.Fprintln(os.Stderr, "Skipping seed because it is disabled in config.toml for project:", flags.ProjectRef)
		} else if seeds, err = migration.GetPendingSeeds(ctx, utils.Config.Db.Seed.SqlPaths, conn, afero.NewIOFS(fsys)); err != nil {
			return err
		}
	}
	var globals []string
	if includeRoles {
		if exists, err := afero.Exists(fsys, utils.CustomRolesPath); err != nil {
			return errors.Errorf("failed to find custom roles: %w", err)
		} else if exists {
			globals = append(globals, utils.CustomRolesPath)
		}
	}
	if len(pending) == 0 && len(seeds) == 0 && len(globals) == 0 {
		fmt.Println("Remote database is up to date.")
		return nil
	}
	// Push pending migrations
	if dryRun {
		if len(globals) > 0 {
			fmt.Fprintln(os.Stderr, "Would create custom roles "+utils.Bold(globals[0])+"...")
		}
		if len(pending) > 0 {
			fmt.Fprintln(os.Stderr, "Would push these migrations:")
			fmt.Fprint(os.Stderr, confirmPushAll(pending))
		}
		if len(seeds) > 0 {
			fmt.Fprintln(os.Stderr, "Would seed these files:")
			fmt.Fprint(os.Stderr, confirmSeedAll(seeds))
		}
	} else {
		if len(globals) > 0 {
			msg := "Do you want to create custom roles in the database cluster?"
			if shouldPush, err := utils.NewConsole().PromptYesNo(ctx, msg, true); err != nil {
				return err
			} else if !shouldPush {
				return errors.New(context.Canceled)
			}
			if err := migration.SeedGlobals(ctx, globals, conn, afero.NewIOFS(fsys)); err != nil {
				return err
			}
		}
		if len(pending) > 0 {
			msg := fmt.Sprintf("Do you want to push these migrations to the remote database?\n%s\n", confirmPushAll(pending))
			if shouldPush, err := utils.NewConsole().PromptYesNo(ctx, msg, true); err != nil {
				return err
			} else if !shouldPush {
				return errors.New(context.Canceled)
			}
			if err := vault.UpsertVaultSecrets(ctx, utils.Config.Db.Vault, conn); err != nil {
				return err
			}
			if err := migration.ApplyMigrations(ctx, pending, conn, afero.NewIOFS(fsys)); err != nil {
				return err
			}
		} else {
			fmt.Fprintln(os.Stderr, "Schema migrations are up to date.")
		}
		if len(seeds) > 0 {
			msg := fmt.Sprintf("Do you want to seed the remote database with these files?\n%s\n", confirmSeedAll(seeds))
			if shouldPush, err := utils.NewConsole().PromptYesNo(ctx, msg, true); err != nil {
				return err
			} else if !shouldPush {
				return errors.New(context.Canceled)
			}
			if err := migration.SeedData(ctx, seeds, conn, afero.NewIOFS(fsys)); err != nil {
				return err
			}
		} else if includeSeed {
			fmt.Fprintln(os.Stderr, "Seed files are up to date.")
		}
	}
	fmt.Println("Finished " + utils.Aqua("supabase db push") + ".")
	return nil
}

func confirmPushAll(pending []string) (msg string) {
	for _, path := range pending {
		filename := filepath.Base(path)
		msg += fmt.Sprintf(" • %s\n", utils.Bold(filename))
	}
	return msg
}

func confirmSeedAll(pending []migration.SeedFile) (msg string) {
	for _, seed := range pending {
		notice := seed.Path
		if seed.Dirty {
			notice += " (hash update)"
		}
		msg += fmt.Sprintf(" • %s\n", utils.Bold(notice))
	}
	return msg
}
