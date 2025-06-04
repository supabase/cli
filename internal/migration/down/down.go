package down

import (
	"context"
	"fmt"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

func Run(ctx context.Context, last uint, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	remoteMigrations, err := migration.ListRemoteMigrations(ctx, conn)
	if err != nil {
		return err
	}
	total := uint(len(remoteMigrations))
	if total <= last {
		utils.CmdSuggestion = fmt.Sprintf("Try %s if you want to revert all migrations.", utils.Aqua("supabase db reset"))
		return errors.Errorf("--last must be smaller than total applied migrations: %d", total)
	}
	version := remoteMigrations[total-last-1]
	return reset.Run(ctx, version, 0, config, fsys)
}
