package utils

import (
	"context"
	"fmt"
	"io"
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

// pg_dumpall --dbname $DB_URL --globals-only --no-role-passwords | sed '/^CREATE ROLE postgres;/d' | sed '/^ALTER ROLE postgres WITH /d' | sed "/^ALTER ROLE .* WITH .* LOGIN /s/;$/ PASSWORD 'postgres';/"
const (
	FallbackGlobalsSql = `--
-- PostgreSQL database cluster dump
--

SET default_transaction_read_only = off;

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

--
-- Roles
--

CREATE ROLE anon;
ALTER ROLE anon WITH NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE authenticated;
ALTER ROLE authenticated WITH NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE authenticator;
ALTER ROLE authenticator WITH NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS PASSWORD 'postgres';
CREATE ROLE dashboard_user;
ALTER ROLE dashboard_user WITH NOSUPERUSER INHERIT CREATEROLE CREATEDB NOLOGIN REPLICATION NOBYPASSRLS;
CREATE ROLE pgbouncer;
ALTER ROLE pgbouncer WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS PASSWORD 'postgres';
CREATE ROLE service_role;
ALTER ROLE service_role WITH NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION BYPASSRLS;
CREATE ROLE supabase_admin;
ALTER ROLE supabase_admin WITH SUPERUSER INHERIT CREATEROLE CREATEDB LOGIN REPLICATION BYPASSRLS PASSWORD 'postgres';
CREATE ROLE supabase_auth_admin;
ALTER ROLE supabase_auth_admin WITH NOSUPERUSER NOINHERIT CREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS PASSWORD 'postgres';
CREATE ROLE supabase_storage_admin;
ALTER ROLE supabase_storage_admin WITH NOSUPERUSER NOINHERIT CREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS PASSWORD 'postgres';
--
-- User Configurations
--

--
-- User Config "postgres"
--

ALTER ROLE postgres SET search_path TO E'\\$user', 'public', 'extensions';
--
-- User Configurations
--

--
-- User Config "supabase_admin"
--

ALTER ROLE supabase_admin SET search_path TO '$user', 'public', 'auth', 'extensions';
--
-- User Configurations
--

--
-- User Config "supabase_auth_admin"
--

ALTER ROLE supabase_auth_admin SET search_path TO 'auth';
--
-- User Configurations
--

--
-- User Config "supabase_storage_admin"
--

ALTER ROLE supabase_storage_admin SET search_path TO 'storage';


--
-- Role memberships
--

GRANT anon TO authenticator GRANTED BY postgres;
GRANT authenticated TO authenticator GRANTED BY postgres;
GRANT service_role TO authenticator GRANTED BY postgres;
GRANT supabase_admin TO authenticator GRANTED BY postgres;




--
-- PostgreSQL database cluster dump complete
--

`
	ShadowDbName   = "supabase_shadow"
	PgbouncerImage = "edoburu/pgbouncer:1.15.0"
	KongImage      = "library/kong:2.1"
	GotrueImage    = "supabase/gotrue:v2.0.5"
	RealtimeImage  = "supabase/realtime:v0.15.0"
	PostgrestImage = "postgrest/postgrest:v7.0.1"
	DifferImage    = "supabase/pgadmin-schema-diff:cli-0.0.2"
	PgMetaImage    = "supabase/postgres-meta:v0.24.1"
	// Latest supabase/postgres image *on hosted platform*.
	LatestDbImage = "supabase/postgres:0.14.0"
)

var (
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
	PgMetaPort  string
	DbImage     string
	ProjectId   string
	NetId       string
	DbId        string
	PgbouncerId string
	KongId      string
	GotrueId    string
	RealtimeId  string
	RestId      string
	DifferId    string
	PgMetaId    string
)

func GetCurrentTimestamp() string {
	// Magic number: https://stackoverflow.com/q/45160822.
	return time.Now().UTC().Format("20060102150405")
}

func GetCurrentBranch() (*string, error) {
	content, err := os.ReadFile(".git/HEAD")
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

func AssertDockerIsRunning() {
	if _, err := Docker.Ping(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, "❌ Failed to connect to Docker daemon. Is Docker running?")
		os.Exit(1)
	}
}

func LoadConfig() {
	viper.SetConfigFile("supabase/config.json")
	if err := viper.ReadInConfig(); err != nil {
		fmt.Fprintln(os.Stderr, "❌ Failed to read config:", err)
		os.Exit(1)
	}

	ApiPort = fmt.Sprint(viper.GetUint("ports.api"))
	DbPort = fmt.Sprint(viper.GetUint("ports.db"))
	PgMetaPort = fmt.Sprint(viper.GetUint("ports.pgMeta"))
	dbVersion := viper.GetString("dbVersion")
	switch dbVersion {
	case "120007":
		DbImage = "supabase/postgres:0.14.0"
	default:
		fmt.Fprintln(os.Stderr, "❌ Failed reading config: Invalid `dbVersion` "+dbVersion+".")
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
	DifferId = "supabase_differ_" + ProjectId
	PgMetaId = "supabase_pg_meta_" + ProjectId
}

func AssertSupabaseStartIsRunning() {
	if _, err := Docker.ContainerInspect(context.Background(), DbId); err != nil {
		fmt.Fprintln(os.Stderr, "❌ `supabase start` is not running.")
		os.Exit(1)
	}
}

func DockerExec(ctx context.Context, container string, cmd []string) (io.Reader, error) {
	exec, err := Docker.ContainerExecCreate(ctx, container, types.ExecConfig{Cmd: cmd, AttachStderr: true, AttachStdout: true})
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

func DockerRun(ctx context.Context, name string, config *container.Config, hostConfig *container.HostConfig) error {
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
