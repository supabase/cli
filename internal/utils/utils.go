package utils

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/spf13/viper"
)

type (
	DiffEntry struct {
		Type             string  `json:"type"`
		Title            string  `json:"title"`
		Status           string  `json:"status"`
		SourceDdl        string  `json:"source_ddl"`
		TargetDdl        string  `json:"target_ddl"`
		DiffDdl          string  `json:"diff_ddl"`
		GroupName        string  `json:"group_name"`
		SourceSchemaName *string `json:"source_schema_name"`
	}
)

const (
	ShadowDbName   = "supabase_shadow"
	PgbouncerImage = "edoburu/pgbouncer:1.15.0"
	KongImage      = "library/kong:2.1"
	GotrueImage    = "supabase/gotrue:v2.1.8"
	RealtimeImage  = "supabase/realtime:v0.15.0"
	PostgrestImage = "postgrest/postgrest:v8.0.0"
	StorageImage   = "supabase/storage-api:v0.9.3"
	DifferImage    = "supabase/pgadmin-schema-diff:cli-0.0.3"
	PgmetaImage    = "supabase/postgres-meta:v0.26.1"
)

var (
	// pg_dumpall --globals-only --no-role-passwords --dbname $DB_URL \
	// | sed '/^CREATE ROLE postgres;/d' \
	// | sed '/^ALTER ROLE postgres WITH /d' \
	// | sed "/^ALTER ROLE .* WITH .* LOGIN /s/;$/ PASSWORD 'postgres';/"
	//go:embed templates/fallback_globals_sql
	FallbackGlobalsSql []byte

	Docker = func() *client.Client {
		docker, err := client.NewClientWithOpts(client.FromEnv)
		if err != nil {
			fmt.Fprintln(os.Stderr, "❌ Failed to initialize Docker client.")
			os.Exit(1)
		}
		return docker
	}()

	ApiPort     string
	DbPort      string
	PgmetaPort  string
	DbImage     string
	ProjectId   string
	NetId       string
	DbId        string
	PgbouncerId string
	KongId      string
	GotrueId    string
	RealtimeId  string
	RestId      string
	StorageId   string
	DifferId    string
	PgmetaId    string
)

func GetCurrentTimestamp() string {
	// Magic number: https://stackoverflow.com/q/45160822.
	return time.Now().UTC().Format("20060102150405")
}

func GetCurrentBranch() (*string, error) {
	gitRoot, err := GetGitRoot()
	if err != nil {
		return nil, err
	}
	content, err := os.ReadFile(*gitRoot + "/.git/HEAD")
	if err != nil {
		return nil, err
	}

	prefix := "ref: refs/heads/"
	if content := strings.TrimSpace(string(content)); strings.HasPrefix(content, prefix) {
		branchName := content[len(prefix):]
		return &branchName, nil
	}

	return nil, nil
}

func AssertDockerIsRunning() error {
	if _, err := Docker.Ping(context.Background()); err != nil {
		return errors.New("❌ Failed to connect to Docker daemon. Is Docker running?")
	}

	return nil
}

func AssertPortIsAvailable(port string) error {
	listener, err := net.Listen("tcp4", ":"+port)
	if err != nil {
		return err
	}

	if err := listener.Close(); err != nil {
		return err
	}
	return nil
}

func LoadConfig() {
	viper.SetConfigFile("supabase/config.json")
	if err := viper.ReadInConfig(); err != nil {
		fmt.Fprintln(os.Stderr, "❌ Failed to read config:", err)
		os.Exit(1)
	}

	ApiPort = fmt.Sprint(viper.GetUint("ports.api"))
	DbPort = fmt.Sprint(viper.GetUint("ports.db"))
	PgmetaPort = fmt.Sprint(viper.GetUint("ports.pgMeta"))
	dbVersion := viper.GetString("dbVersion")
	if dbVersion == "120000" ||
		dbVersion == "120001" ||
		dbVersion == "120002" ||
		dbVersion == "120003" ||
		dbVersion == "120004" ||
		dbVersion == "120005" ||
		dbVersion == "120006" ||
		dbVersion == "120007" ||
		dbVersion == "120008" {
		DbImage = "supabase/postgres:0.14.0"
	} else if dbVersion == "130000" ||
		dbVersion == "130001" ||
		dbVersion == "130002" ||
		dbVersion == "130003" ||
		dbVersion == "130004" {
		DbImage = "supabase/postgres:13.3.0"
	} else {
		fmt.Fprintln(os.Stderr, "❌ Failed reading config: Invalid dbVersion "+dbVersion+".")
		os.Exit(1)
	}
	ProjectId = viper.GetString("projectId")
	NetId = "supabase_network_" + ProjectId
	DbId = "supabase_db_" + ProjectId
	PgbouncerId = "supabase_pgbouncer_" + ProjectId
	KongId = "supabase_kong_" + ProjectId
	GotrueId = "supabase_auth_" + ProjectId
	RealtimeId = "supabase_realtime_" + ProjectId
	RestId = "supabase_rest_" + ProjectId
	StorageId = "supabase_storage_" + ProjectId
	DifferId = "supabase_differ_" + ProjectId
	PgmetaId = "supabase_pg_meta_" + ProjectId
}

func AssertSupabaseStartIsRunning() {
	if _, err := Docker.ContainerInspect(context.Background(), DbId); err != nil {
		fmt.Fprintln(os.Stderr, "❌ `supabase start` is not running.")
		os.Exit(1)
	}
}

func DockerExec(ctx context.Context, container string, cmd []string) (io.Reader, error) {
	exec, err := Docker.ContainerExecCreate(
		ctx,
		container,
		types.ExecConfig{Cmd: cmd, AttachStderr: true, AttachStdout: true},
	)
	if err != nil {
		return nil, err
	}

	resp, err := Docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
	if err != nil {
		return nil, err
	}

	if err := Docker.ContainerExecStart(ctx, exec.ID, types.ExecStartCheck{}); err != nil {
		return nil, err
	}

	return resp.Reader, nil
}

// NOTE: There's a risk of data race with reads & writes from `DockerRun` and
// reads from `DockerRemoveAll`, but since they're expected to be run on the
// same thread, this is fine.
var containers []string

func DockerRun(
	ctx context.Context,
	name string,
	config *container.Config,
	hostConfig *container.HostConfig,
) error {
	if _, err := Docker.ContainerCreate(ctx, config, hostConfig, nil, nil, name); err != nil {
		return err
	}
	containers = append(containers, name)

	if err := Docker.ContainerStart(ctx, name, types.ContainerStartOptions{}); err != nil {
		return err
	}

	return nil
}

func DockerRemoveAll() {
	var wg sync.WaitGroup

	for _, container := range containers {
		wg.Add(1)

		go func(container string) {
			if err := Docker.ContainerRemove(context.Background(), container, types.ContainerRemoveOptions{
				RemoveVolumes: true,
				Force:         true,
			}); err != nil {
				fmt.Fprintln(os.Stderr, "⚠️", err)
			}

			wg.Done()
		}(container)
	}

	wg.Wait()
}

func GetGitRoot() (*string, error) {
	origWd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	for {
		_, err := os.ReadDir(".git")
		if err == nil {
			gitRoot, err := os.Getwd()
			if err != nil {
				return nil, err
			}
			if err := os.Chdir(origWd); err != nil {
				return nil, err
			}
			return &gitRoot, nil
		}
		if err := os.Chdir(".."); err != nil {
			return nil, err
		}
	}
}
