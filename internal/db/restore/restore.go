package restore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/docker/docker/pkg/stdcopy"
	"github.com/supabase/cli/internal/utils"
)

// Args: dbname
const terminateDbSqlFmt = `ALTER DATABASE "%[1]s" CONNECTION LIMIT 0;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '%[1]s';
`

var ctx = context.TODO()

func DbRestore() error {
	utils.LoadConfig()
	utils.AssertSupabaseStartIsRunning()

	var currBranch string
	branchPtr, err := utils.GetCurrentBranch()
	if err != nil {
		return err
	}
	if branchPtr != nil {
		currBranch = *branchPtr
	}

	// 1. Pause realtime. Need to be done before recreating the db because we
	// cannot drop the db while there's an active logical replication slot.

	if err := utils.Docker.ContainerPause(ctx, utils.RealtimeId); err != nil {
		return err
	}
	defer func() {
		if err := utils.Docker.ContainerUnpause(ctx, utils.RealtimeId); err != nil {
			fmt.Fprintln(os.Stderr, "Failed to unpause Realtime:", err)
			os.Exit(1)
		}
	}()

	// 2. Recreate db.

	fmt.Println("Resetting database...")

	// https://dba.stackexchange.com/a/11895
	out, err := utils.DockerExec(ctx, utils.DbId, []string{
		"sh", "-c", "psql --username postgres <<'EOSQL' " +
			"&& dropdb --force --username postgres '" + currBranch + "' " +
			"&& createdb --username postgres '" + currBranch + `'
BEGIN;
` + fmt.Sprintf(terminateDbSqlFmt, currBranch) + `
COMMIT;
EOSQL
`,
	})
	if err != nil {
		return err
	}
	if _, err := stdcopy.StdCopy(os.Stdout, os.Stderr, out); err != nil {
		return err
	}

	// 3. Apply migrations + seed.

	migrations, err := os.ReadDir("supabase/migrations")
	if err != nil {
		return err
	}

	for _, migration := range migrations {
		fmt.Println("Applying migration " + migration.Name() + "...")

		content, err := os.ReadFile("supabase/migrations/" + migration.Name())
		if err != nil {
			return err
		}

		out, err := utils.DockerExec(ctx, utils.DbId, []string{
			"sh", "-c", "psql --username postgres --dbname '" + currBranch + `' <<'EOSQL'
BEGIN;
` + string(content) + `
COMMIT;
EOSQL
`,
		})
		if err != nil {
			return err
		}
		var errBuf bytes.Buffer
		if _, err := stdcopy.StdCopy(os.Stdout, &errBuf, out); err != nil {
			return err
		}

		if errBuf.Len() > 0 {
			return errors.New(
				"Error running migration " + migration.Name() + ": " + errBuf.String(),
			)
		}
	}

	fmt.Println("Applying seed...")

	content, err := os.ReadFile("supabase/seed.sql")
	if errors.Is(err, os.ErrNotExist) {
		// skip
	} else if err != nil {
		return err
	} else {
		out, err := utils.DockerExec(ctx, utils.DbId, []string{
			"sh", "-c", "psql --username postgres --dbname '" + currBranch + `' <<'EOSQL'
BEGIN;
` + string(content) + `
COMMIT;
EOSQL
`,
		})
		if err != nil {
			return err
		}
		var errBuf bytes.Buffer
		if _, err := stdcopy.StdCopy(os.Stdout, &errBuf, out); err != nil {
			return err
		}

		if errBuf.Len() > 0 {
			return errors.New("Error running seed: " + errBuf.String())
		}
	}

	fmt.Println("Finished db restore on " + currBranch + ".")

	return nil
}
