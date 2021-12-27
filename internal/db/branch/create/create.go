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
	if err := utils.AssertSupabaseStartIsRunning(); err != nil {
		return err
	}

	if utils.IsBranchNameReserved(branch) {
		return errors.New("Cannot create branch " + utils.Aqua(branch) + ": branch name is reserved.")
	}

	if valid, err := regexp.MatchString(`[[:word:]-]+`, branch); err != nil {
		return err
	} else if !valid {
		return errors.New("Branch name " + utils.Aqua(branch) + " is invalid. Must match [0-9A-Za-z_-]+.")
	}

	if _, err := os.ReadDir("supabase/.branches/" + branch); errors.Is(err, os.ErrNotExist) {
		// skip
	} else if err != nil {
		return err
	} else {
		return errors.New("Branch " + utils.Aqua(branch) + " already exists.")
	}

	var dumpBuf bytes.Buffer
	if err := func() error {
		out, err := utils.DockerExec(ctx, utils.DbId, []string{
			"pg_dump", "postgresql://postgres:postgres@localhost/postgres",
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
		return fmt.Errorf("Error creating branch: %w", err)
	}

	if err := func() error {
		out, err := utils.DockerExec(ctx, utils.DbId, []string{
			"sh", "-c", `psql --set ON_ERROR_STOP=on postgresql://postgres:postgres@localhost/postgres <<'EOSQL'
CREATE DATABASE "` + branch + `";
\connect ` + branch + `
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
		return fmt.Errorf("Error creating branch %s: %w", utils.Aqua(branch), err)
	}

	if err := os.Mkdir("supabase/.branches/"+branch, 0755); err != nil {
		return err
	}

	fmt.Println("Created branch " + utils.Aqua(branch) + ".")
	return nil
}
