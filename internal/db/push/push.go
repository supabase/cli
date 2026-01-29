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

func Run(ctx context.Context, dryRun, ignoreVersionMismatch bool, includeRoles, includeSeed, skipDriftCheck bool, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if dryRun {
		fmt.Fprintln(os.Stderr, "DRY RUN: migrations will *not* be pushed to the database.")
	}

	// Check for local drift before connecting to remote
	// Only check when:
	// 1. Not skipped via flag
	// 2. Not pushing to local database (drift is only meaningful for remote)
	// 3. Local database is running
	var newMigration string
	if !skipDriftCheck && !utils.IsLocalDatabase(config) {
		if err := utils.AssertSupabaseDbIsRunning(); err == nil {
			result, err := CheckLocalDrift(ctx, fsys)
			if err != nil {
				// Non-fatal warning - don't block push if drift check fails
				fmt.Fprintf(os.Stderr, "%s Failed to check for drift: %s\n\n", utils.Yellow("Warning:"), err.Error())
			} else if result.HasDrift {
				fmt.Fprint(os.Stderr, FormatDriftWarning(result))

				if dryRun {
					// In dry-run mode, just show what would happen
					fmt.Fprintln(os.Stderr, "\nWould prompt to create migration or continue.")
				} else {
					action, err := PromptDriftAction(ctx)
					if err != nil {
						return err
					}
					switch action {
					case DriftActionCreateMigration:
						// Create migration using SQL already in memory (no redundant diff!)
						path, err := CreateMigrationFromDrift(ctx, result.DiffSQL, fsys)
						if err != nil {
							return err
						}
						newMigration = path
						fmt.Fprintf(os.Stderr, "\nCreated migration: %s\n\n", utils.Bold(path))
					case DriftActionContinue:
						// Continue without creating migration
						fmt.Fprintln(os.Stderr)
					case DriftActionCancel:
						return errors.New(context.Canceled)
					}
				}
			} else {
				fmt.Fprintln(os.Stderr, utils.Green("✓")+" No uncommitted schema changes detected.\n")
			}
		}
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

	// If we created a new migration from drift, add it to the pending list
	if newMigration != "" {
		pending = append(pending, newMigration)
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
