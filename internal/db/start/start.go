package start

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/go-connections/nat"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	if err := utils.AssertSupabaseCliIsSetUpFS(fsys); err != nil {
		return err
	}
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	if err := utils.AssertDockerIsRunning(); err != nil {
		return err
	}
	if _, err := utils.Docker.ContainerInspect(ctx, utils.DbId); err == nil {
		fmt.Fprintln(os.Stderr, "Postgres database is already running.")
		return nil
	}
	return StartDatabase(ctx, fsys, os.Stderr)
}

func StartDatabase(ctx context.Context, fsys afero.Fs, w io.Writer, options ...func(*pgx.ConnConfig)) error {
	config := container.Config{
		Image: utils.DbImage,
		Env: []string{
			"POSTGRES_PASSWORD=postgres",
			"POSTGRES_HOST=/var/run/postgresql",
		},
		Healthcheck: &container.HealthConfig{
			Test:     []string{"CMD", "pg_isready", "-U", "postgres", "-h", "localhost", "-p", "5432"},
			Interval: 2 * time.Second,
			Timeout:  2 * time.Second,
			Retries:  10,
		},
	}
	if utils.Config.Db.MajorVersion >= 14 {
		config.Cmd = []string{"postgres",
			"-c", "config_file=/etc/postgresql/postgresql.conf",
			// One log file per hour, 24 hours retention
			"-c", "log_destination=csvlog",
			"-c", "logging_collector=on",
			"-c", "log_directory=/var/log/postgresql",
			"-c", "log_filename=server_%H00_UTC.log",
			"-c", "log_file_mode=0640",
			"-c", "log_rotation_age=60",
			"-c", "log_rotation_size=0",
			"-c", "log_truncate_on_rotation=on",
			// Ref: https://postgrespro.com/list/thread-id/2448092
			"-c", `search_path="$user",public,extensions`,
		}
	}
	hostPort := strconv.FormatUint(uint64(utils.Config.Db.Port), 10)
	hostConfig := container.HostConfig{
		PortBindings:  nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: hostPort}}},
		RestartPolicy: container.RestartPolicy{Name: "always"},
		Binds:         []string{"/dev/null:/docker-entrypoint-initdb.d/migrate.sh:ro"},
	}
	fmt.Fprintln(w, "Starting database...")
	if _, err := utils.DockerStart(ctx, config, hostConfig, utils.DbId); err != nil {
		return err
	}
	err := initDatabase(ctx, fsys, w, options...)
	if err != nil {
		utils.DockerRemove(utils.DbId)
	}
	return err
}

func initDatabase(ctx context.Context, fsys afero.Fs, w io.Writer, options ...func(*pgx.ConnConfig)) error {
	if !reset.WaitForHealthyService(ctx, utils.DbId, 20*time.Second) {
		fmt.Fprintln(os.Stderr, "Database is not healthy.")
	}
	// Initialise globals
	conn, err := utils.ConnectLocalPostgres(ctx, "localhost", utils.Config.Db.Port, "postgres", options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := diff.BatchExecDDL(ctx, conn, strings.NewReader(utils.GlobalsSql)); err != nil {
		return err
	}

	fmt.Fprintln(w, "Restoring branches...")

	// Create branch dir if missing
	branchDir := filepath.Dir(utils.CurrBranchPath)
	if err := utils.MkdirIfNotExistFS(fsys, branchDir); err != nil {
		return err
	}
	branches, err := afero.ReadDir(fsys, branchDir)
	if err != nil {
		return err
	}
	// Ensure `_current_branch` file exists.
	currBranch, err := utils.GetCurrentBranchFS(fsys)
	if errors.Is(err, os.ErrNotExist) {
		currBranch = "main"
		if err := afero.WriteFile(fsys, utils.CurrBranchPath, []byte(currBranch), 0644); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	// Restore every branch dump
	for _, branch := range branches {
		if !branch.IsDir() {
			continue
		}
		dumpPath := filepath.Join(branchDir, branch.Name(), "dump.sql")
		content, err := fsys.Open(dumpPath)
		if errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(os.Stderr, "Error restoring "+utils.Aqua(branch.Name())+": branch was not dumped.")
			if err := fsys.RemoveAll(filepath.Dir(dumpPath)); err != nil {
				return err
			}
			continue
		} else if err != nil {
			return err
		}
		defer content.Close()
		// Restore current branch to postgres directly
		if branch.Name() == currBranch {
			if err := diff.BatchExecDDL(ctx, conn, content); err != nil {
				return err
			}
			continue
		}
		// TODO: restoring non-main branch may break extensions that require postgres
		createDb := `CREATE DATABASE "` + branch.Name() + `";`
		if _, err := conn.Exec(ctx, createDb); err != nil {
			return err
		}
		// Connect to branch database
		branchConn, err := utils.ConnectLocalPostgres(ctx, "localhost", utils.Config.Db.Port, branch.Name())
		if err != nil {
			return err
		}
		defer branchConn.Close(context.Background())
		// Restore dump, reporting any error
		if err := diff.BatchExecDDL(ctx, branchConn, content); err != nil {
			return err
		}
	}
	// Branch is already initialised
	if _, err = fsys.Stat(filepath.Join(branchDir, currBranch)); !errors.Is(err, os.ErrNotExist) {
		return err
	}

	fmt.Fprintln(w, "Setting up initial schema...")
	if err := reset.InitialiseDatabase(ctx, conn, fsys); err != nil {
		return err
	}

	// Ensure `main` branch exists.
	if err := utils.MkdirIfNotExistFS(fsys, utils.MigrationsDir); err != nil {
		return err
	}
	return fsys.Mkdir(filepath.Join(branchDir, currBranch), 0755)
}
