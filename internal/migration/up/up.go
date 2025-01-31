package up

import (
	"context"
	"fmt"
	"strings"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
	"github.com/supabase/cli/pkg/vault"
)

func Run(ctx context.Context, includeAll bool, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	pending, err := GetPendingMigrations(ctx, includeAll, conn, fsys)
	if err != nil {
		return err
	}
	if err := vault.UpsertVaultSecrets(ctx, utils.Config.Db.Vault, conn); err != nil {
		return err
	}
	return migration.ApplyMigrations(ctx, pending, conn, afero.NewIOFS(fsys))
}

func GetPendingMigrations(ctx context.Context, includeAll bool, conn *pgx.Conn, fsys afero.Fs) ([]string, error) {
	remoteMigrations, err := migration.ListRemoteMigrations(ctx, conn)
	if err != nil {
		return nil, err
	}
	localMigrations, err := migration.ListLocalMigrations(utils.MigrationsDir, afero.NewIOFS(fsys))
	if err != nil {
		return nil, err
	}
	diff, err := migration.FindPendingMigrations(localMigrations, remoteMigrations)
	if errors.Is(err, migration.ErrMissingLocal) {
		utils.CmdSuggestion = suggestRevertHistory(diff)
	} else if errors.Is(err, migration.ErrMissingRemote) {
		if includeAll {
			pending := localMigrations[len(remoteMigrations)+len(diff):]
			return append(diff, pending...), nil
		}
		utils.CmdSuggestion = suggestIgnoreFlag(diff)
	}
	return diff, err
}

func suggestRevertHistory(versions []string) string {
	result := fmt.Sprintln("\nMake sure your local git repo is up-to-date. If the error persists, try repairing the migration history table:")
	result += fmt.Sprintln(utils.Bold("supabase migration repair --status reverted " + strings.Join(versions, " ")))
	result += fmt.Sprintln("\nAnd update local migrations to match remote database:")
	result += fmt.Sprintln(utils.Bold("supabase db pull"))
	return result
}

func suggestIgnoreFlag(paths []string) string {
	result := "\nRerun the command with --include-all flag to apply these migrations:\n"
	result += fmt.Sprintln(utils.Bold(strings.Join(paths, "\n")))
	return result
}
