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
	"github.com/supabase/cli/internal/db/push"
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
	// Skip logflare container in db start
	utils.Config.Analytics.Enabled = false
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
			"POSTGRES_PASSWORD=" + utils.Config.Db.Password,
			"POSTGRES_HOST=/var/run/postgresql",
			"POSTGRES_INITDB_ARGS=--lc-ctype=C.UTF-8",
			"POSTGRES_INITDB_ARGS=--lc-collate=C.UTF-8",
			"JWT_SECRET=" + utils.Config.Auth.JwtSecret,
			fmt.Sprintf("JWT_EXP=%d", utils.Config.Auth.JwtExpiry),
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

func StartDatabase(ctx context.Context, fsys afero.Fs, w io.Writer, options ...func(*pgx.ConnConfig)) error {
	config := NewContainerConfig()
	hostPort := strconv.FormatUint(uint64(utils.Config.Db.Port), 10)
	hostConfig := WithSyslogConfig(container.HostConfig{
		PortBindings:  nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: hostPort}}},
		RestartPolicy: container.RestartPolicy{Name: "always"},
		Binds: []string{
			utils.DbId + ":/var/lib/postgresql/data",
			utils.ConfigId + ":/etc/postgresql-custom",
		},
		ExtraHosts: []string{"host.docker.internal:host-gateway"},
	})
	if utils.Config.Db.MajorVersion <= 14 {
		config.Entrypoint = nil
		hostConfig.Tmpfs = map[string]string{"/docker-entrypoint-initdb.d": ""}
	}
	// Creating volume will not override existing volume, so we must inspect explicitly
	_, err := utils.Docker.VolumeInspect(ctx, utils.DbId)
	noBackupVolume := client.IsErrNotFound(err)
	if noBackupVolume {
		fmt.Fprintln(w, "Starting database...")
	} else {
		fmt.Fprintln(w, "Starting database from backup...")
	}
	if _, err := utils.DockerStart(ctx, config, hostConfig, utils.DbId); err != nil {
		return err
	}
	if !reset.WaitForHealthyService(ctx, utils.DbId, reset.HealthTimeout) {
		return reset.ErrDatabase
	}
	// Initialise if we are on PG14 and there's no existing db volume
	if noBackupVolume {
		if err := setupDatabase(ctx, fsys, w, options...); err != nil {
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

func initSchema(ctx context.Context, conn *pgx.Conn, host string, w io.Writer) error {
	fmt.Fprintln(w, "Setting up initial schema...")
	if utils.Config.Db.MajorVersion <= 14 {
		return initSchema14(ctx, conn)
	}
	return reset.InitSchema15(ctx, host)
}

func initSchema14(ctx context.Context, conn *pgx.Conn) error {
	if err := apply.BatchExecDDL(ctx, conn, strings.NewReader(utils.GlobalsSql)); err != nil {
		return err
	}
	return apply.BatchExecDDL(ctx, conn, strings.NewReader(utils.InitialSchemaSql))
}

func setupDatabase(ctx context.Context, fsys afero.Fs, w io.Writer, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{}, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := SetupDatabase(ctx, conn, utils.DbId, w, fsys); err != nil {
		return err
	}
	return apply.MigrateAndSeed(ctx, "", conn, fsys)
}

func SetupDatabase(ctx context.Context, conn *pgx.Conn, host string, w io.Writer, fsys afero.Fs) error {
	if err := initSchema(ctx, conn, host, w); err != nil {
		return err
	}
	return push.CreateCustomRoles(ctx, conn, w, fsys)
}
