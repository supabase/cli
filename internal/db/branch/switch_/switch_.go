package switch_

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/lint"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, target string, fsys afero.Fs) error {
	// 1. Sanity checks
	{
		if err := utils.AssertSupabaseCliIsSetUpFS(fsys); err != nil {
			return err
		}
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
		if err := utils.AssertSupabaseDbIsRunning(); err != nil {
			return err
		}
		if target != "main" && utils.IsBranchNameReserved(target) {
			return errors.New("Cannot switch branch " + utils.Aqua(target) + ": branch name is reserved.")
		}
		branchPath := filepath.Join(filepath.Dir(utils.CurrBranchPath), target)
		if _, err := fsys.Stat(branchPath); errors.Is(err, os.ErrNotExist) {
			return errors.New("Branch " + utils.Aqua(target) + " does not exist.")
		} else if err != nil {
			return err
		}
	}

	// 2. Update current branch file
	currBranch, err := utils.GetCurrentBranchFS(fsys)
	if err != nil {
		currBranch = "main"
	}

	if err := afero.WriteFile(fsys, utils.CurrBranchPath, []byte(target), 0644); err != nil {
		return err
	}

	// 3. Switch Postgres database
	if err := swapDatabase(ctx, currBranch, target); err != nil {
		if err := afero.WriteFile(fsys, utils.CurrBranchPath, []byte(currBranch), 0644); err != nil {
			fmt.Fprintln(os.Stderr, "Failed to rollback branch", utils.Aqua(currBranch)+":", err)
		}
		return errors.New("Error switching to branch " + utils.Aqua(target) + ": " + err.Error())
	}

	fmt.Println("Switched to branch " + utils.Aqua(target) + ".")
	return nil
}

func swapDatabase(ctx context.Context, source, target string, options ...func(*pgx.ConnConfig)) error {
	conn, err := lint.ConnectLocalPostgres(ctx, "localhost", utils.Config.Db.Port, "template1", options...)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	if err := reset.DisconnectClients(ctx, conn); err != nil {
		return err
	}
	defer reset.RestartDatabase(ctx)
	drop := "ALTER DATABASE postgres RENAME TO " + source + ";"
	if _, err := conn.Exec(ctx, drop); err != nil {
		return err
	}
	swap := "ALTER DATABASE " + target + " RENAME TO postgres;"
	if _, err := conn.Exec(ctx, swap); err != nil {
		return err
	}
	return nil
}
