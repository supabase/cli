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
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	if err := utils.AssertDockerIsRunning(ctx); err != nil {
		return err
	}
	if _, err := utils.Docker.ContainerInspect(ctx, utils.DbId); err == nil {
		fmt.Fprintln(os.Stderr, "Postgres database is already running.")
		return nil
	}
	err := StartDatabase(ctx, fsys, os.Stderr)
	if err != nil {
		utils.DockerRemoveAll(context.Background())
	}
	return err
}

func StartDatabase(ctx context.Context, fsys afero.Fs, w io.Writer, options ...func(*pgx.ConnConfig)) error {
	config := container.Config{
		Image: utils.DbImage,
		Env: []string{
			"POSTGRES_PASSWORD=postgres",
			"POSTGRES_HOST=/var/run/postgresql",
			"POSTGRES_INITDB_ARGS=--lc-ctype=C.UTF-8",
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
		Binds:         []string{utils.DbId + ":/var/lib/postgresql/data"},
		Tmpfs:         map[string]string{"/docker-entrypoint-initdb.d": ""},
	}

	if utils.Config.Analytics.Enabled {
		hostConfig.LogConfig = container.LogConfig{
			Type: "syslog",
			Config: map[string]string{
				"syslog-address": fmt.Sprintf("tcp://localhost:%d", utils.Config.Analytics.VectorPort),
				"tag":            "db",
			},
		}
	}

	fmt.Fprintln(w, "Starting database...")
	// Creating volume will not override existing volume, so we must inspect explicitly
	_, err := utils.Docker.VolumeInspect(ctx, utils.DbId)
	if _, err := utils.DockerStart(ctx, config, hostConfig, utils.DbId); err != nil {
		return err
	}
	if !reset.WaitForHealthyService(ctx, utils.DbId, 20*time.Second) {
		fmt.Fprintln(os.Stderr, "Database is not healthy.")
	}
	if !client.IsErrNotFound(err) {
		return initCurrentBranch(fsys)
	}
	return initDatabase(ctx, fsys, w, options...)
}

func initCurrentBranch(fsys afero.Fs) error {
	// Create _current_branch file to avoid breaking db branch commands
	if _, err := fsys.Stat(utils.CurrBranchPath); err == nil || !errors.Is(err, os.ErrNotExist) {
		return err
	}
	branchDir := filepath.Dir(utils.CurrBranchPath)
	if err := utils.MkdirIfNotExistFS(fsys, branchDir); err != nil {
		return err
	}
	return afero.WriteFile(fsys, utils.CurrBranchPath, []byte("main"), 0644)
}

func initDatabase(ctx context.Context, fsys afero.Fs, w io.Writer, options ...func(*pgx.ConnConfig)) error {
	if err := initCurrentBranch(fsys); err != nil {
		return err
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
	if roles, err := fsys.Open(utils.CustomRolesPath); err == nil {
		if err := diff.BatchExecDDL(ctx, conn, roles); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	fmt.Fprintln(w, "Setting up initial schema...")
	return reset.InitialiseDatabase(ctx, conn, fsys)
}
