package switch_

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, target string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// 1. Sanity checks
	{
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

	// 2. Check current branch
	currBranch, err := utils.GetCurrentBranchFS(fsys)
	if err != nil {
		// Assume we are on main branch
		currBranch = "main"
	}

	// 3. Switch Postgres database
	if currBranch == target {
		fmt.Println("Already on branch " + utils.Aqua(target) + ".")
	} else if err := switchDatabase(ctx, currBranch, target, options...); err != nil {
		return errors.New("Error switching to branch " + utils.Aqua(target) + ": " + err.Error())
	} else {
		fmt.Println("Switched to branch " + utils.Aqua(target) + ".")
	}

	// 4. Update current branch
	if err := afero.WriteFile(fsys, utils.CurrBranchPath, []byte(target), 0644); err != nil {
		return errors.New("Unable to update local branch file. Fix by running: echo '" + target + "' > " + utils.CurrBranchPath)
	}
	return nil
}

func switchDatabase(ctx context.Context, source, target string, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{Database: "template1"}, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := reset.DisconnectClients(ctx, conn); err != nil {
		return err
	}
	defer reset.RestartDatabase(context.Background(), os.Stderr)
	backup := "ALTER DATABASE postgres RENAME TO " + source + ";"
	if _, err := conn.Exec(ctx, backup); err != nil {
		return err
	}
	rename := "ALTER DATABASE " + target + " RENAME TO postgres;"
	if _, err := conn.Exec(ctx, rename); err != nil {
		rollback := "ALTER DATABASE " + source + " RENAME TO postgres;"
		if _, err := conn.Exec(ctx, rollback); err != nil {
			fmt.Fprintln(os.Stderr, "Failed to rollback database:", err)
		}
		return err
	}
	return nil
}
