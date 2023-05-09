package start

import (
	"context"
	_ "embed"
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
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/migration/apply"
	"github.com/supabase/cli/internal/utils"
)

//go:embed templates/schema.sql
var initialSchema string

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

func NewContainerConfig() container.Config {
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
		Entrypoint: []string{"sh", "-c", `cat <<'EOF' > /etc/postgresql.schema.sql && docker-entrypoint.sh postgres -D /etc/postgresql
` + initialSchema + `
EOF
`},
	}
	if utils.Config.Db.MajorVersion >= 14 {
		config.Cmd = []string{"postgres",
			"-c", "config_file=/etc/postgresql/postgresql.conf",
			// Ref: https://postgrespro.com/list/thread-id/2448092
			"-c", `search_path="$user",public,extensions`,
		}
	}
	return config
}

var noBackupVolume bool = true

func StartDatabase(ctx context.Context, fsys afero.Fs, w io.Writer, options ...func(*pgx.ConnConfig)) error {
	config := NewContainerConfig()
	hostPort := strconv.FormatUint(uint64(utils.Config.Db.Port), 10)
	hostConfig := WithSyslogConfig(container.HostConfig{
		PortBindings:  nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: hostPort}}},
		RestartPolicy: container.RestartPolicy{Name: "always"},
		Binds:         []string{utils.DbId + ":/var/lib/postgresql/data"},
		ExtraHosts:    []string{"host.docker.internal:host-gateway"},
	})
	if utils.Config.Db.MajorVersion <= 14 {
		config.Entrypoint = nil
		hostConfig.Tmpfs = map[string]string{"/docker-entrypoint-initdb.d": ""}
	}
	// Creating volume will not override existing volume, so we must inspect explicitly
	_, err := utils.Docker.VolumeInspect(ctx, utils.DbId)
	noBackupVolume = client.IsErrNotFound(err)
	if noBackupVolume {
		fmt.Fprintln(w, "Starting database...")
	} else {
		fmt.Fprintln(w, "Starting database from backup...")
	}
	if _, err := utils.DockerStart(ctx, config, hostConfig, utils.DbId); err != nil {
		return err
	}
	if !reset.WaitForHealthyService(ctx, utils.DbId, 20*time.Second) {
		fmt.Fprintln(os.Stderr, "Database is not healthy.")
	}
	// Initialise if we are on PG14 and there's no existing db volume
	if noBackupVolume && utils.Config.Db.MajorVersion <= 14 {
		if err := initDatabase(ctx, w, options...); err != nil {
			return err
		}
	}
	return initCurrentBranch(fsys)
}

func WithSyslogConfig(hostConfig container.HostConfig) container.HostConfig {
	if utils.Config.Analytics.Enabled {
		hostConfig.LogConfig.Type = "syslog"
		hostConfig.LogConfig.Config = map[string]string{
			"syslog-address": fmt.Sprintf("tcp://localhost:%d", utils.Config.Analytics.VectorPort),
			"tag":            "{{.Name}}",
		}
	}
	return hostConfig
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

func initDatabase(ctx context.Context, w io.Writer, options ...func(*pgx.ConnConfig)) error {
	// Initialise globals
	conn, err := utils.ConnectLocalPostgres(ctx, "localhost", utils.Config.Db.Port, "postgres", options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	fmt.Fprintln(w, "Setting up initial schema...")
	if err := apply.BatchExecDDL(ctx, conn, strings.NewReader(utils.GlobalsSql)); err != nil {
		return err
	}
	return apply.BatchExecDDL(ctx, conn, strings.NewReader(utils.InitialSchemaSql))
}

func SetupDatabase(ctx context.Context, dbConfig pgconn.Config, fsys afero.Fs, w io.Writer, options ...func(*pgx.ConnConfig)) error {
	if !noBackupVolume {
		return nil
	}
	if dbConfig.Host != utils.DbId {
		return nil
	}
	conn, err := utils.ConnectLocalPostgres(ctx, "localhost", utils.Config.Db.Port, "postgres", options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if roles, err := fsys.Open(utils.CustomRolesPath); err == nil {
		fmt.Fprintln(w, "Creating custom roles "+utils.Bold(utils.CustomRolesPath)+"...")
		if err := apply.BatchExecDDL(ctx, conn, roles); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return reset.InitialiseDatabase(ctx, conn, fsys)
}
