package start

import (
	"context"
	_ "embed"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/cenkalti/backoff/v4"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/apply"
	"github.com/supabase/cli/internal/status"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

var (
	HealthTimeout = 120 * time.Second
	//go:embed templates/schema.sql
	initialSchema string
	//go:embed templates/_supabase.sql
	_supabaseSchema string
)

func Run(ctx context.Context, fsys afero.Fs) error {
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	if err := utils.AssertSupabaseDbIsRunning(); err == nil {
		fmt.Fprintln(os.Stderr, "Postgres database is already running.")
		return nil
	} else if !errors.Is(err, utils.ErrNotRunning) {
		return err
	}
	err := StartDatabase(ctx, fsys, os.Stderr)
	if err != nil {
		if err := utils.DockerRemoveAll(context.Background(), os.Stderr, utils.Config.ProjectId); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}
	return err
}

func NewContainerConfig() container.Config {
	env := []string{
		"POSTGRES_PASSWORD=" + utils.Config.Db.Password,
		"POSTGRES_HOST=/var/run/postgresql",
		"JWT_SECRET=" + utils.Config.Auth.JwtSecret,
		fmt.Sprintf("JWT_EXP=%d", utils.Config.Auth.JwtExpiry),
	}
	if len(utils.Config.Experimental.OrioleDBVersion) > 0 {
		env = append(env,
			"POSTGRES_INITDB_ARGS=--lc-collate=C",
			fmt.Sprintf("S3_ENABLED=%t", true),
			"S3_HOST="+utils.Config.Experimental.S3Host,
			"S3_REGION="+utils.Config.Experimental.S3Region,
			"S3_ACCESS_KEY="+utils.Config.Experimental.S3AccessKey,
			"S3_SECRET_KEY="+utils.Config.Experimental.S3SecretKey,
		)
	} else {
		env = append(env, "POSTGRES_INITDB_ARGS=--lc-collate=C.UTF-8")
	}
	config := container.Config{
		Image: utils.Config.Db.Image,
		Env:   env,
		Healthcheck: &container.HealthConfig{
			Test:     []string{"CMD", "pg_isready", "-U", "postgres", "-h", "127.0.0.1", "-p", "5432"},
			Interval: 10 * time.Second,
			Timeout:  2 * time.Second,
			Retries:  3,
		},
		Entrypoint: []string{"sh", "-c", `
cat <<'EOF' > /etc/postgresql.schema.sql && \
cat <<'EOF' > /etc/postgresql-custom/pgsodium_root.key && \
cat <<'EOF' >> /etc/postgresql/postgresql.conf && \
docker-entrypoint.sh postgres -D /etc/postgresql
` + initialSchema + `
` + _supabaseSchema + `
EOF
` + utils.Config.Db.RootKey + `
EOF
` + utils.Config.Db.Settings.ToPostgresConfig() + `
EOF`},
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
	hostConfig := container.HostConfig{
		PortBindings:  nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: hostPort}}},
		RestartPolicy: container.RestartPolicy{Name: "always"},
		Binds: []string{
			utils.DbId + ":/var/lib/postgresql/data",
			utils.ConfigId + ":/etc/postgresql-custom",
		},
	}
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
		config.Entrypoint = []string{"sh", "-c", `
cat <<'EOF' > /docker-entrypoint-initdb.d/supabase_schema.sql && \
cat <<'EOF' >> /etc/postgresql/postgresql.conf && \
docker-entrypoint.sh postgres -D /etc/postgresql
` + _supabaseSchema + `
EOF
` + utils.Config.Db.Settings.ToPostgresConfig() + `
EOF`}
		hostConfig.Tmpfs = map[string]string{"/docker-entrypoint-initdb.d": ""}
	}
	// Creating volume will not override existing volume, so we must inspect explicitly
	_, err := utils.Docker.VolumeInspect(ctx, utils.DbId)
	utils.NoBackupVolume = client.IsErrNotFound(err)
	if utils.NoBackupVolume {
		fmt.Fprintln(w, "Starting database...")
	} else {
		fmt.Fprintln(w, "Starting database from backup...")
	}
	if _, err := utils.DockerStart(ctx, config, hostConfig, networkingConfig, utils.DbId); err != nil {
		return err
	}
	if err := WaitForHealthyService(ctx, HealthTimeout, utils.DbId); err != nil {
		return err
	}
	// Initialize if we are on PG14 and there's no existing db volume
	if utils.NoBackupVolume {
		if err := SetupLocalDatabase(ctx, "", fsys, w, options...); err != nil {
			return err
		}
	}
	return initCurrentBranch(fsys)
}

func NewBackoffPolicy(ctx context.Context, timeout time.Duration) backoff.BackOff {
	policy := backoff.WithMaxRetries(
		backoff.NewConstantBackOff(time.Second),
		uint64(timeout.Seconds()),
	)
	return backoff.WithContext(policy, ctx)
}

func WaitForHealthyService(ctx context.Context, timeout time.Duration, started ...string) error {
	probe := func() error {
		var errHealth []error
		var unhealthy []string
		for _, container := range started {
			if err := status.IsServiceReady(ctx, container); err != nil {
				unhealthy = append(unhealthy, container)
				errHealth = append(errHealth, err)
			}
		}
		started = unhealthy
		return errors.Join(errHealth...)
	}
	policy := NewBackoffPolicy(ctx, timeout)
	err := backoff.Retry(probe, policy)
	if err != nil && !errors.Is(err, context.Canceled) {
		// Print container logs for easier debugging
		for _, containerId := range started {
			fmt.Fprintln(os.Stderr, containerId, "container logs:")
			if err := utils.DockerStreamLogsOnce(context.Background(), containerId, os.Stderr, os.Stderr); err != nil {
				fmt.Fprintln(os.Stderr, err)
			}
		}
	}
	return err
}

func IsUnhealthyError(err error) bool {
	// Health check always returns a joinError
	_, ok := err.(interface{ Unwrap() []error })
	return ok
}

func initCurrentBranch(fsys afero.Fs) error {
	// Create _current_branch file to avoid breaking db branch commands
	if _, err := fsys.Stat(utils.CurrBranchPath); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return errors.Errorf("failed init current branch: %w", err)
	}
	return utils.WriteFile(utils.CurrBranchPath, []byte("main"), fsys)
}

func initSchema(ctx context.Context, conn *pgx.Conn, host string, w io.Writer) error {
	fmt.Fprintln(w, "Setting up initial schema...")
	if utils.Config.Db.MajorVersion <= 14 {
		if file, err := migration.NewMigrationFromReader(strings.NewReader(utils.GlobalsSql)); err != nil {
			return err
		} else if err := file.ExecBatch(ctx, conn); err != nil {
			return err
		}
		return InitSchema14(ctx, conn)
	}
	return initSchema15(ctx, host)
}

func InitSchema14(ctx context.Context, conn *pgx.Conn) error {
	sql := utils.InitialSchemaPg14Sql
	if utils.Config.Db.MajorVersion == 13 {
		sql = utils.InitialSchemaPg13Sql
	}
	file, err := migration.NewMigrationFromReader(strings.NewReader(sql))
	if err != nil {
		return err
	}
	return file.ExecBatch(ctx, conn)
}

func initRealtimeJob(host string) utils.DockerJob {
	return utils.DockerJob{
		Image: utils.Config.Realtime.Image,
		Env: []string{
			"PORT=4000",
			"DB_HOST=" + host,
			"DB_PORT=5432",
			"DB_USER=supabase_admin",
			"DB_PASSWORD=" + utils.Config.Db.Password,
			"DB_NAME=postgres",
			"DB_AFTER_CONNECT_QUERY=SET search_path TO _realtime",
			"DB_ENC_KEY=" + utils.Config.Realtime.EncryptionKey,
			"API_JWT_SECRET=" + utils.Config.Auth.JwtSecret,
			"METRICS_JWT_SECRET=" + utils.Config.Auth.JwtSecret,
			"APP_NAME=realtime",
			"SECRET_KEY_BASE=" + utils.Config.Realtime.SecretKeyBase,
			"ERL_AFLAGS=" + utils.ToRealtimeEnv(utils.Config.Realtime.IpVersion),
			"DNS_NODES=''",
			"RLIMIT_NOFILE=",
			"SEED_SELF_HOST=true",
			"RUN_JANITOR=true",
			fmt.Sprintf("MAX_HEADER_LENGTH=%d", utils.Config.Realtime.MaxHeaderLength),
		},
		Cmd: []string{"/app/bin/realtime", "eval", fmt.Sprintf(`{:ok, _} = Application.ensure_all_started(:realtime)
{:ok, _} = Realtime.Tenants.health_check("%s")`, utils.Config.Realtime.TenantId)},
	}
}

func initStorageJob(host string) utils.DockerJob {
	return utils.DockerJob{
		Image: utils.Config.Storage.Image,
		Env: []string{
			"DB_INSTALL_ROLES=false",
			"ANON_KEY=" + utils.Config.Auth.AnonKey,
			"SERVICE_KEY=" + utils.Config.Auth.ServiceRoleKey,
			"PGRST_JWT_SECRET=" + utils.Config.Auth.JwtSecret,
			fmt.Sprintf("DATABASE_URL=postgresql://supabase_storage_admin:%s@%s:5432/postgres", utils.Config.Db.Password, host),
			fmt.Sprintf("FILE_SIZE_LIMIT=%v", utils.Config.Storage.FileSizeLimit),
			"STORAGE_BACKEND=file",
			"STORAGE_FILE_BACKEND_PATH=/mnt",
			"TENANT_ID=stub",
			// TODO: https://github.com/supabase/storage-api/issues/55
			"REGION=stub",
			"GLOBAL_S3_BUCKET=stub",
		},
		Cmd: []string{"node", "dist/scripts/migrate-call.js"},
	}
}

func initAuthJob(host string) utils.DockerJob {
	return utils.DockerJob{
		Image: utils.Config.Auth.Image,
		Env: []string{
			"API_EXTERNAL_URL=" + utils.Config.Api.ExternalUrl,
			"GOTRUE_LOG_LEVEL=error",
			"GOTRUE_DB_DRIVER=postgres",
			fmt.Sprintf("GOTRUE_DB_DATABASE_URL=postgresql://supabase_auth_admin:%s@%s:5432/postgres", utils.Config.Db.Password, host),
			"GOTRUE_SITE_URL=" + utils.Config.Auth.SiteUrl,
			"GOTRUE_JWT_SECRET=" + utils.Config.Auth.JwtSecret,
		},
		Cmd: []string{"gotrue", "migrate"},
	}
}

func initSchema15(ctx context.Context, host string) error {
	// Apply service migrations
	var initJobs []utils.DockerJob
	if utils.Config.Realtime.Enabled {
		initJobs = append(initJobs, initRealtimeJob(host))
	}
	if utils.Config.Storage.Enabled {
		initJobs = append(initJobs, initStorageJob(host))
	}
	if utils.Config.Auth.Enabled {
		initJobs = append(initJobs, initAuthJob(host))
	}
	logger := utils.GetDebugLogger()
	for _, job := range initJobs {
		if err := utils.DockerRunJob(ctx, job, io.Discard, logger); err != nil {
			return err
		}
	}
	return nil
}

func SetupLocalDatabase(ctx context.Context, version string, fsys afero.Fs, w io.Writer, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectLocalPostgres(ctx, pgconn.Config{}, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := SetupDatabase(ctx, conn, utils.DbId, w, fsys); err != nil {
		return err
	}
	return apply.MigrateAndSeed(ctx, version, conn, fsys)
}

func SetupDatabase(ctx context.Context, conn *pgx.Conn, host string, w io.Writer, fsys afero.Fs) error {
	if err := initSchema(ctx, conn, host, w); err != nil {
		return err
	}
	err := migration.SeedGlobals(ctx, []string{utils.CustomRolesPath}, conn, afero.NewIOFS(fsys))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
