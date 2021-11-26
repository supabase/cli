package create

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"

	"github.com/docker/docker/pkg/stdcopy"
	"github.com/supabase/cli/internal/utils"
)

var ctx = context.Background()

func Run(branch string) error {
	utils.AssertSupabaseStartIsRunning()

	if utils.IsBranchNameReserved(branch) {
		return errors.New("Cannot create branch " + branch + ": branch is reserved.")
	}

	if valid, err := regexp.MatchString(`[[:word:]-]+`, branch); err != nil {
		return err
	} else if !valid {
		return errors.New("Branch name " + branch + " is invalid. Must match [0-9A-Za-z_-]+.")
	}

	if _, err := os.ReadDir("supabase/.branches/" + branch); errors.Is(err, os.ErrNotExist) {
		// skip
	} else if err != nil {
		return err
	} else {
		return errors.New("Branch " + branch + " already exists.")
	}

	currBranch, err := utils.GetCurrentBranch()
	if err != nil {
		return err
	}

	var dumpBuf bytes.Buffer
	if err := func() error {
		out, err := utils.DockerExec(ctx, utils.DbId, []string{
			"sh", "-c", "pg_dump --username postgres -d '" + currBranch + "'",
		})
		if err != nil {
			return err
		}

		var errBuf bytes.Buffer
		if _, err := stdcopy.StdCopy(&dumpBuf, &errBuf, out); err != nil {
			return err
		}
		if errBuf.Len() > 0 {
			return errors.New(errBuf.String())
		}

		return nil
	}(); err != nil {
		return errors.New("Error dumping current branch " + currBranch + ": " + err.Error())
	}

	if err := func() error {
		out, err := utils.DockerExec(ctx, utils.DbId, []string{
			"sh", "-c", "createdb --username postgres '" + branch + "' && psql --username postgres --dbname '" + branch + `' <<'EOSQL'
BEGIN;
` + dumpBuf.String() + `
COMMIT;
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
			return errors.New(errBuf.String())
		}

		return nil
	}(); err != nil {
		return errors.New("Error creating branch " + branch + ": " + err.Error())
	}

	if err := os.Mkdir("supabase/.branches/"+branch, 0755); err != nil {
		return err
	}
	if err := os.WriteFile("supabase/.branches/"+branch+"/dump.sql", dumpBuf.Bytes(), 0644); err != nil {
		return err
	}

	fmt.Println("Created branch " + branch + ".")
	return nil
}
