package db

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"

	"github.com/docker/docker/pkg/stdcopy"
	"github.com/supabase/cli/internal/utils"
)

// Args: dbname
const terminateDbSqlFmt = `ALTER DATABASE "%[1]s" CONNECTION LIMIT 0;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '%[1]s';
`

var ctx = context.TODO()

func DbDump(name string) error {
	utils.LoadConfig()
	utils.AssertSupabaseStartIsRunning()

	// 1. Create shadow db and run migrations

	out, err := utils.DockerExec(ctx, utils.DbId, []string{"createdb", "--username", "postgres", utils.ShadowDbName})
	stdcopy.StdCopy(os.Stdout, os.Stderr, out)

	fmt.Println("Created shadow db.")

	// FIXME: Abort when a migration fails.
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
			"sh", "-c", "psql --username postgres --dbname '" + utils.ShadowDbName + `' <<'EOSQL'
BEGIN;
` + string(content) + `
COMMIT;
EOSQL
`,
		})
		stdcopy.StdCopy(os.Stdout, os.Stderr, out)
	}

	fmt.Println("Finished running migrations on shadow db.")

	fmt.Println("Diffing...")

	var currBranch string
	branchPtr, err := utils.GetCurrentBranch()
	if err != nil {
		return err
	}
	if branchPtr != nil {
		currBranch = *branchPtr
	}

	// 2. Diff it (target) with local db (source), write it as a new migration.

	{
		out, err = utils.DockerExec(ctx, utils.DifferId, []string{
			"sh", "-c", "/venv/bin/python3 -u cli.py " +
				"'postgres://postgres:postgres@" + utils.DbId + ":5432/" + currBranch + "' " +
				"'postgres://postgres:postgres@" + utils.DbId + ":5432/" + utils.ShadowDbName + "' " +
				// Filter out BEGIN & END because we already wrap migrations in a transaction.
				`| awk '!x{x=sub("^BEGIN;$","")}{print}' | tac | awk '!x{x=sub("^END;$","")}{print}' | tac`,
		})
		if err != nil {
			return err
		}

		f, err := os.Create("supabase/migrations/" + utils.GetCurrentTimestamp() + "_" + name + ".sql")
		if err != nil {
			return err
		}
		if _, err := stdcopy.StdCopy(f, os.Stderr, out); err != nil {
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
	}

	fmt.Println("Wrote new migration file.")

	// 3. Dump to `database`.
	{
		os.RemoveAll("supabase/.temp/database")
		if err := os.Mkdir("supabase/.temp/database", 0755); err != nil {
			return err
		}
		if err := os.Mkdir("supabase/.temp/database/functions", 0755); err != nil {
			return err
		}
		if err := os.Mkdir("supabase/.temp/database/materialized_views", 0755); err != nil {
			return err
		}
		if err := os.Mkdir("supabase/.temp/database/tables", 0755); err != nil {
			return err
		}
		if err := os.Mkdir("supabase/.temp/database/types", 0755); err != nil {
			return err
		}
		if err := os.Mkdir("supabase/.temp/database/views", 0755); err != nil {
			return err
		}

		out, err := utils.DockerExec(ctx, utils.DifferId, []string{
			"/venv/bin/python3", "-u", "cli.py", "--json-diff",
			"postgres://postgres:postgres@" + utils.DbId + ":5432/" + currBranch,
			"postgres://postgres:postgres@" + utils.DbId + ":5432/template1",
		})
		if err != nil {
			return err
		}

		var diffBytesBuf bytes.Buffer
		if _, err := stdcopy.StdCopy(&diffBytesBuf, os.Stderr, out); err != nil {
			return err
		}

		var diffJson []utils.DiffEntry
		if err := json.Unmarshal(diffBytesBuf.Bytes(), &diffJson); err != nil {
			return err
		}

		for _, diffEntry := range diffJson {
			if diffEntry.GroupName == "extensions" ||
				(diffEntry.SourceSchemaName != nil && *diffEntry.SourceSchemaName == "extensions") {
				continue
			}

			switch diffEntry.Type {
			case "function":
				re := regexp.MustCompile(`(.+)\(.*\)`)
				name := re.FindStringSubmatch(diffEntry.Title)[1]
				if err := os.WriteFile(
					"supabase/.temp/database/functions/"+diffEntry.GroupName+"."+name+".sql",
					[]byte(diffEntry.SourceDdl),
					0644,
				); err != nil {
					return err
				}
			case "mview":
				if err := os.WriteFile(
					"supabase/.temp/database/materialized_views/"+diffEntry.GroupName+"."+diffEntry.Title+".sql",
					[]byte(diffEntry.SourceDdl),
					0644,
				); err != nil {
					return err
				}
			case "table":
				if err := os.WriteFile(
					"supabase/.temp/database/tables/"+diffEntry.GroupName+"."+diffEntry.Title+".sql",
					[]byte(diffEntry.SourceDdl),
					0644,
				); err != nil {
					return err
				}
			case "trigger_function":
				re := regexp.MustCompile(`(.+)\(.*\)`)
				var schema string
				if diffEntry.SourceSchemaName == nil {
					schema = "public"
				} else {
					schema = *diffEntry.SourceSchemaName
				}
				name := re.FindStringSubmatch(diffEntry.Title)[1]
				if err := os.WriteFile(
					"supabase/.temp/database/functions/"+schema+"."+name+".sql",
					[]byte(diffEntry.SourceDdl),
					0644,
				); err != nil {
					return err
				}
			case "type":
				if err := os.WriteFile(
					"supabase/.temp/database/types/"+diffEntry.GroupName+"."+diffEntry.Title+".sql",
					[]byte(diffEntry.SourceDdl),
					0644,
				); err != nil {
					return err
				}
			case "view":
				if err := os.WriteFile(
					"supabase/.temp/database/views/"+diffEntry.GroupName+"."+diffEntry.Title+".sql",
					[]byte(diffEntry.SourceDdl),
					0644,
				); err != nil {
					return err
				}
			}
		}

		os.RemoveAll("supabase/database")
		os.Rename("supabase/.temp/database", "supabase/database")
	}

	// 4. Drop shadow db.
	out, err = utils.DockerExec(ctx, utils.DbId, []string{"dropdb", "--username", "postgres", utils.ShadowDbName})
	if err != nil {
		return err
	}
	stdcopy.StdCopy(os.Stdout, os.Stderr, out)

	fmt.Println("Finished db dump on " + currBranch + ".")

	return nil
}

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

	// https://dba.stackexchange.com/a/11895
	// TODO: Use dropdb --force instead in Postgres 13
	out, err := utils.DockerExec(ctx, utils.DbId, []string{
		"sh", "-c", "psql --username postgres <<'EOSQL' " +
			"&& dropdb --username postgres '" + currBranch + "' && createdb --username postgres '" + currBranch + `'
BEGIN;
` + fmt.Sprintf(terminateDbSqlFmt, currBranch) + `
COMMIT;
EOSQL
`,
	})
	if err != nil {
		return err
	}
	stdcopy.StdCopy(os.Stdout, os.Stderr, out)

	// 3. Apply migrations + seed.
	migrations, err := os.ReadDir("supabase/migrations")
	if err != nil {
		return err
	}

	// FIXME: Abort when migration fails.
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
		stdcopy.StdCopy(os.Stdout, os.Stderr, out)
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
		stdcopy.StdCopy(os.Stdout, os.Stderr, out)
	}

	fmt.Println("Finished db restore on " + currBranch + ".")

	return nil
}
