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
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/push"
	"github.com/supabase/cli/internal/migration/apply"
	"github.com/supabase/cli/internal/status"
	"github.com/supabase/cli/internal/utils"
)

var (
	ErrDatabase   = errors.New("database is not healthy")
	HealthTimeout = 120 * time.Second
	//go:embed templates/schema.sql
	initialSchema string
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
		Image: utils.Config.Db.Image,
		Env: []string{
			"POSTGRES_PASSWORD=" + utils.Config.Db.Password,
			"POSTGRES_HOST=/var/run/postgresql",
			"POSTGRES_INITDB_ARGS=--lc-ctype=C.UTF-8",
			"POSTGRES_INITDB_ARGS=--lc-collate=C.UTF-8",
			"JWT_SECRET=" + utils.Config.Auth.JwtSecret,
			fmt.Sprintf("JWT_EXP=%d", utils.Config.Auth.JwtExpiry),
		},
		Healthcheck: &container.HealthConfig{
			Test:     []string{"CMD", "pg_isready", "-U", "postgres", "-h", "127.0.0.1", "-p", "5432"},
			Interval: 10 * time.Second,
			Timeout:  2 * time.Second,
			Retries:  3,
		},
		Entrypoint: []string{"sh", "-c", `cat <<'EOF' > /etc/postgresql.schema.sql && cat <<'EOF' > /etc/postgresql-custom/pgsodium_root.key && docker-entrypoint.sh postgres -D /etc/postgresql
` + initialSchema + `
EOF
` + utils.Config.Db.RootKey + `
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

func NewHostConfig() container.HostConfig {
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
	return hostConfig
}

func StartDatabase(ctx context.Context, fsys afero.Fs, w io.Writer, options ...func(*pgx.ConnConfig)) error {
	config := NewContainerConfig()
	hostConfig := NewHostConfig()
	networkingConfig := network.NetworkingConfig{
		EndpointsConfig: map[string]*network.EndpointSettings{
			utils.NetId: {
				Aliases: utils.DbAliases,
			},
		},
	}
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
	if _, err := utils.DockerStart(ctx, config, hostConfig, networkingConfig, utils.DbId); err != nil {
		return err
	}
	if !WaitForHealthyService(ctx, utils.DbId, HealthTimeout) {
		return ErrDatabase
	}
	// Initialize if we are on PG14 and there's no existing db volume
	if noBackupVolume {
		if err := setupDatabase(ctx, fsys, w, options...); err != nil {
			return err
		}
	}
	return initCurrentBranch(fsys)
}

func RetryEverySecond(ctx context.Context, callback func() bool, timeout time.Duration) bool {
	now := time.Now()
	expiry := now.Add(timeout)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for t := now; t.Before(expiry) && ctx.Err() == nil; t = <-ticker.C {
		if callback() {
			return true
		}
	}
	return false
}

func WaitForHealthyService(ctx context.Context, container string, timeout time.Duration) bool {
	probe := func() bool {
		return status.AssertContainerHealthy(ctx, container) == nil
	}
	return RetryEverySecond(ctx, probe, timeout)
}

func WithSyslogConfig(hostConfig container.HostConfig) container.HostConfig {
	if utils.Config.Analytics.Enabled {
		hostConfig.LogConfig.Type = "syslog"
		hostConfig.LogConfig.Config = map[string]string{
			"syslog-address": fmt.Sprintf("tcp://127.0.0.1:%d", utils.Config.Analytics.VectorPort),
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
	return initSchema15(ctx, host)
}

func initSchema14(ctx context.Context, conn *pgx.Conn) error {
	if err := apply.BatchExecDDL(ctx, conn, strings.NewReader(utils.GlobalsSql)); err != nil {
		return err
	}
	return apply.BatchExecDDL(ctx, conn, strings.NewReader(utils.InitialSchemaSql))
}

func initSchema15(ctx context.Context, host string) error {
	// Apply service migrations
	if err := utils.DockerRunOnceWithStream(ctx, utils.Config.Storage.Image, []string{
		"ANON_KEY=" + utils.Config.Auth.AnonKey,
		"SERVICE_KEY=" + utils.Config.Auth.ServiceRoleKey,
		"PGRST_JWT_SECRET=" + utils.Config.Auth.JwtSecret,
		fmt.Sprintf("DATABASE_URL=postgresql://supabase_storage_admin:%s@%s:5432/postgres", utils.Config.Db.Password, host),
		fmt.Sprintf("FILE_SIZE_LIMIT=%v", utils.Config.Storage.FileSizeLimit),
		"STORAGE_BACKEND=file",
		"TENANT_ID=stub",
		// TODO: https://github.com/supabase/storage-api/issues/55
		"REGION=stub",
		"GLOBAL_S3_BUCKET=stub",
	}, []string{"node", "dist/scripts/migrate-call.js"}, io.Discard, os.Stderr); err != nil {
		return err
	}
	return utils.DockerRunOnceWithStream(ctx, utils.Config.Auth.Image, []string{
		fmt.Sprintf("API_EXTERNAL_URL=http://127.0.0.1:%v", utils.Config.Api.Port),
		"GOTRUE_LOG_LEVEL=error",
		"GOTRUE_DB_DRIVER=postgres",
		fmt.Sprintf("GOTRUE_DB_DATABASE_URL=postgresql://supabase_auth_admin:%s@%s:5432/postgres", utils.Config.Db.Password, host),
		"GOTRUE_SITE_URL=" + utils.Config.Auth.SiteUrl,
		"GOTRUE_JWT_SECRET=" + utils.Config.Auth.JwtSecret,
	}, []string{"gotrue", "migrate"}, io.Discard, os.Stderr)
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
