package switch_

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/supabase/cli/internal/utils"
)

var ctx = context.Background()

func Run(target string) error {
	if err := utils.AssertSupabaseStartIsRunning(); err != nil {
		return err
	}

	errBranchNotExist := errors.New("Branch " + utils.Aqua(target) + " does not exist.")

	branches, err := os.ReadDir("supabase/.branches")
	if errors.Is(err, os.ErrNotExist) {
		return errBranchNotExist
	}

	for _, branch := range branches {
		if branch.Name() == "_current_branch" {
			continue
		}

		if branch.Name() == target {
			currBranch, err := utils.GetCurrentBranch()
			if err != nil {
				return err
			}

			if err := os.WriteFile(utils.CurrBranchPath, []byte(target), 0644); err != nil {
				return err
			}

			// Prevent new db connections to be established while db is recreated.
			if err := utils.Docker.NetworkDisconnect(ctx, utils.NetId, utils.DbId, false); err != nil {
				return err
			}

			// Recreate current branch.
			{
				out, err := utils.DockerExec(ctx, utils.DbId, []string{
					"sh", "-c", `psql --set ON_ERROR_STOP=on postgresql://postgres:postgres@localhost/template1 <<'EOSQL'
BEGIN;
` + fmt.Sprintf(utils.TerminateDbSqlFmt, "postgres") + `
COMMIT;
ALTER DATABASE postgres RENAME TO "` + currBranch + `";
ALTER DATABASE "` + target + `" RENAME TO postgres;
EOSQL
`,
				})
				if err != nil {
					return err
				}
				var errBuf bytes.Buffer
				if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
					return err
				}
				if errBuf.Len() > 0 {
					return errors.New("Error switching to branch " + utils.Aqua(target) + ": " + errBuf.String())
				}
			}

			if err := utils.Docker.NetworkConnect(ctx, utils.NetId, utils.DbId, &network.EndpointSettings{}); err != nil {
				return err
			}

			fmt.Println("Switched to branch " + utils.Aqua(target) + ".")
			return nil
		}
	}

	return errBranchNotExist
}
