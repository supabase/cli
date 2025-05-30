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

var errOutOfRange = errors.New("last version must be smaller than total applied migrations")

func Run(ctx context.Context, last int, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	remoteMigrations, err := migration.ListRemoteMigrations(ctx, conn)
	if err != nil {
		return err
	}
	version := ""
	if i := len(remoteMigrations) - last; i > 0 {
		version = remoteMigrations[i-1]
	} else {
		if i == 0 {
			utils.CmdSuggestion = fmt.Sprintf("Try %s if you want to revert all migrations.", utils.Aqua("supabase db reset"))
		}
		return errors.New(errOutOfRange)
	}
	return reset.Run(ctx, version, config, fsys)
}
