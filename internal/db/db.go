package db

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/supabase/cli/internal/utils"
)

const shadowDbName = "supabase_shadow"

func DbDump() {
	// TODO: check if `supabase start` is running

	docker, err := client.NewEnvClient()
	if err != nil {
		panic(err)
	}

	ctx := context.TODO()

	// create shadow db

	exec, err := docker.ContainerExecCreate(ctx, "supabase_db_TODO", types.ExecConfig{
		Cmd: []string{
			"createdb",
			"--username", "postgres",
			shadowDbName,
		},
		AttachStderr: true,
		AttachStdout: true,
	})
	if err != nil {
		panic(err)
	}
	resp, err := docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
	if err != nil {
		panic(err)
	}
	if err := docker.ContainerExecStart(ctx, exec.ID, types.ExecStartCheck{}); err != nil {
		panic(err)
	}
	io.Copy(os.Stdout, resp.Reader)

	log.Println("Created shadow db.")

	// run migrations on it

	migrations, err := os.ReadDir("supabase/migrations")
	if err != nil {
		panic(err)
	}

	for _, migration := range migrations {
		log.Printf("Applying migration %s...\n", migration.Name())
		exec, err = docker.ContainerExecCreate(ctx, "supabase_db_TODO", types.ExecConfig{
			Cmd: []string{
				"psql",
				"--username", "postgres",
				"--dbname", shadowDbName,
				"--file", fmt.Sprintf("/docker-entrypoint-initdb.d/%s", migration.Name()),
			},
			AttachStderr: true,
			AttachStdout: true,
		})
		if err != nil {
			panic(err)
		}
		resp, err := docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
		if err != nil {
			panic(err)
		}
		if err := docker.ContainerExecStart(ctx, exec.ID, types.ExecStartCheck{}); err != nil {
			panic(err)
		}
		io.Copy(os.Stdout, resp.Reader)
	}

	log.Println("Finished running migrations on shadow db.")

	// diff it with local db

	log.Println("Diffing...")

	var currBranch string
	branchPtr, err := utils.GetCurrentBranch()
	if err != nil {
		panic(err)
	}
	if branchPtr != nil {
		currBranch = *branchPtr
	}

	exec, err = docker.ContainerExecCreate(ctx, "supabase_differ_TODO", types.ExecConfig{
		Cmd: []string{
			"/venv/bin/python3",
			"-u", "cli.py",
			fmt.Sprintf("postgres://postgres:postgres@supabase_db_TODO:5432/%s", currBranch),
			"postgres://postgres:postgres@supabase_db_TODO:5432/supabase_shadow",
		},
		AttachStderr: true,
		AttachStdout: true,
	})
	if err != nil {
		panic(err)
	}
	resp, err = docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
	if err != nil {
		panic(err)
	}
	if err := docker.ContainerExecStart(ctx, exec.ID, types.ExecStartCheck{}); err != nil {
		panic(err)
	}

	// write the diff to a new migration file

	// Magic number: https://stackoverflow.com/q/45160822
	f, err := os.Create(
		fmt.Sprintf("supabase/migrations/%s_TODO.sql", time.Now().UTC().Format("20060102150405")),
	)
	if err != nil {
		panic(err)
	}

	stdcopy.StdCopy(f, os.Stderr, resp.Reader)
	if err := f.Close(); err != nil {
		panic(err)
	}

	log.Println("Wrote new migration file.")

	// TODO: dump to `database`

	// drop shadow db

	exec, err = docker.ContainerExecCreate(ctx, "supabase_db_TODO", types.ExecConfig{
		Cmd: []string{
			"dropdb",
			"--username", "postgres",
			shadowDbName,
		},
		AttachStderr: true,
		AttachStdout: true,
	})
	if err != nil {
		panic(err)
	}
	resp, err = docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
	if err != nil {
		panic(err)
	}
	if err := docker.ContainerExecStart(ctx, exec.ID, types.ExecStartCheck{}); err != nil {
		panic(err)
	}
	io.Copy(os.Stdout, resp.Reader)

	log.Println("Dropped shadow db.")
}

func DbRestore() {
	// TODO: check if `supabase start` is running

	var currBranch string
	branchPtr, err := utils.GetCurrentBranch()
	if err != nil {
		panic(err)
	}
	if branchPtr != nil {
		currBranch = *branchPtr
	}

	// init docker client

	docker, err := client.NewEnvClient()
	if err != nil {
		panic(err)
	}

	ctx := context.TODO()

	// pause realtime. need to be done before recreating the db because we
	// cannot drop the db while there's an active logical replication slot

	if err := docker.ContainerPause(ctx, "supabase_realtime_TODO"); err != nil {
		panic(err)
	}

	// recreate db

	// https://dba.stackexchange.com/a/11895
	// TODO: Use dropdb --force instead in Postgres 13
	exec, err := docker.ContainerExecCreate(ctx, "supabase_db_TODO", types.ExecConfig{
		Cmd: []string{
			"psql",
			"--username", "postgres",
			"--command", fmt.Sprintf(`
ALTER DATABASE "%[1]s" CONNECTION LIMIT 0;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '%[1]s';
`, currBranch),
		},
		AttachStderr: true,
		AttachStdout: true,
	})
	if err != nil {
		panic(err)
	}
	resp, err := docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
	if err != nil {
		panic(err)
	}
	if err := docker.ContainerExecStart(ctx, exec.ID, types.ExecStartCheck{}); err != nil {
		panic(err)
	}
	io.Copy(os.Stdout, resp.Reader)

	exec, err = docker.ContainerExecCreate(ctx, "supabase_db_TODO", types.ExecConfig{
		Cmd: []string{
			"dropdb",
			"--username", "postgres",
			currBranch,
		},
		AttachStderr: true,
		AttachStdout: true,
	})
	if err != nil {
		panic(err)
	}
	resp, err = docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
	if err != nil {
		panic(err)
	}
	if err := docker.ContainerExecStart(ctx, exec.ID, types.ExecStartCheck{}); err != nil {
		panic(err)
	}
	io.Copy(os.Stdout, resp.Reader)

	exec, err = docker.ContainerExecCreate(ctx, "supabase_db_TODO", types.ExecConfig{
		Cmd: []string{
			"createdb",
			"--username", "postgres",
			currBranch,
		},
		AttachStderr: true,
		AttachStdout: true,
	})
	if err != nil {
		panic(err)
	}
	resp, err = docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
	if err != nil {
		panic(err)
	}
	if err := docker.ContainerExecStart(ctx, exec.ID, types.ExecStartCheck{}); err != nil {
		panic(err)
	}
	io.Copy(os.Stdout, resp.Reader)

	// restore migrations

	migrations, err := os.ReadDir("supabase/migrations")
	if err != nil {
		panic(err)
	}

	for _, migration := range migrations {
		log.Printf("Applying migration %s...\n", migration.Name())
		exec, err = docker.ContainerExecCreate(ctx, "supabase_db_TODO", types.ExecConfig{
			Cmd: []string{
				"psql",
				"--username", "postgres",
				"--dbname", currBranch,
				"--file", fmt.Sprintf("/docker-entrypoint-initdb.d/%s", migration.Name()),
			},
			AttachStderr: true,
			AttachStdout: true,
		})
		if err != nil {
			panic(err)
		}
		resp, err := docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
		if err != nil {
			panic(err)
		}
		if err := docker.ContainerExecStart(ctx, exec.ID, types.ExecStartCheck{}); err != nil {
			panic(err)
		}
		io.Copy(os.Stdout, resp.Reader)
	}

	// unpause realtime

	if err := docker.ContainerUnpause(ctx, "supabase_realtime_TODO"); err != nil {
		panic(err)
	}

	log.Printf("Finished db restore on %s.\n", currBranch)
}
