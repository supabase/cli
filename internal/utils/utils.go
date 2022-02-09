package utils

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/jsonmessage"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/spf13/viper"
)

type DiffDependencies struct {
	Type string `json:"type"`
}

type DiffEntry struct {
	Type             string             `json:"type"`
	Status           string             `json:"status"`
	DiffDdl          string             `json:"diff_ddl"`
	GroupName        string             `json:"group_name"`
	Dependencies     []DiffDependencies `json:"dependencies"`
	SourceSchemaName *string            `json:"source_schema_name"`
}

// Update initial schemas in internal/utils/templates/initial_schemas when
// updating any one of these.
const (
	GotrueImage   = "supabase/gotrue:v2.5.5"
	RealtimeImage = "supabase/realtime:v0.21.0"
	StorageImage  = "supabase/storage-api:v0.11.0"
)

const (
	ShadowDbName   = "supabase_shadow"
	KongImage      = "library/kong:2.1"
	InbucketImage  = "inbucket/inbucket:stable"
	PostgrestImage = "postgrest/postgrest:v9.0.0.20220107"
	DifferImage    = "supabase/pgadmin-schema-diff:cli-0.0.4"
	PgmetaImage    = "supabase/postgres-meta:v0.33.2"
	// TODO: Hardcode version once provided upstream.
	StudioImage = "supabase/studio:latest"

	// https://dba.stackexchange.com/a/11895
	// Args: dbname
	TerminateDbSqlFmt = `
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '%[1]s';
-- Wait for WAL sender to drop replication slot.
DO 'BEGIN WHILE (SELECT COUNT(*) FROM pg_replication_slots) > 0 LOOP END LOOP; END';
`
)

var (
	Docker = func() *client.Client {
		docker, err := client.NewClientWithOpts(client.WithAPIVersionNegotiation())
		if err != nil {
			fmt.Fprintln(os.Stderr, "Failed to initialize Docker client:", err)
			os.Exit(1)
		}
		return docker
	}()

	ApiPort      string
	InbucketPort string
	DbPort       string
	StudioPort   string
	DbVersion    string
	DbImage      string
	ProjectId    string
	NetId        string
	DbId         string
	KongId       string
	GotrueId     string
	InbucketId   string
	RealtimeId   string
	RestId       string
	StorageId    string
	DifferId     string
	PgmetaId     string
	StudioId     string

	//go:embed templates/globals.sql
	GlobalsSql       string
	InitialSchemaSql string
	//go:embed templates/initial_schemas/13.sql
	initialSchemaPg13Sql string
	//go:embed templates/initial_schemas/14.sql
	initialSchemaPg14Sql string
)

func GetCurrentTimestamp() string {
	// Magic number: https://stackoverflow.com/q/45160822.
	return time.Now().UTC().Format("20060102150405")
}

func GetCurrentBranch() (string, error) {
	branch, err := os.ReadFile("supabase/.branches/_current_branch")
	if err != nil {
		return "", err
	}

	return string(branch), nil
}

func AssertDockerIsRunning() error {
	if _, err := Docker.Ping(context.Background()); err != nil {
		return errors.New("Failed to connect to Docker daemon. Is Docker running?")
	}

	return nil
}

func LoadConfig() error {
	viper.SetConfigFile("supabase/config.json")
	if err := viper.ReadInConfig(); err != nil {
		return fmt.Errorf("Failed to read config: %w", err)
	}

	ApiPort = fmt.Sprint(viper.GetUint("ports.api"))
	if viper.IsSet("ports.inbucket") {
		InbucketPort = fmt.Sprint(viper.GetUint("ports.inbucket"))
	}
	DbPort = fmt.Sprint(viper.GetUint("ports.db"))
	StudioPort = fmt.Sprint(viper.GetUint("ports.studio"))
	DbVersion = viper.GetString("dbVersion")
	switch DbVersion {
	case
		"120000",
		"120001",
		"120002",
		"120003",
		"120004",
		"120005",
		"120006",
		"120007",
		"120008":
		return errors.New("Postgres version 12.x is unsupported. To use the CLI, either start a new project or follow project migration steps here: https://supabase.com/docs/guides/database#migrating-between-projects.")
	case
		"130000",
		"130001",
		"130002",
		"130003",
		"130004":
		DbImage = "supabase/postgres:13.3.0"
		InitialSchemaSql = initialSchemaPg13Sql
	case
		"140000",
		"140001":
		DbImage = "supabase/postgres:14.1.0"
		InitialSchemaSql = initialSchemaPg14Sql
	default:
		return errors.New("Failed reading config: Invalid " + Aqua("dbVersion") + ": " + DbVersion + ".")
	}
	ProjectId = viper.GetString("projectId")
	NetId = "supabase_network_" + ProjectId
	DbId = "supabase_db_" + ProjectId
	KongId = "supabase_kong_" + ProjectId
	GotrueId = "supabase_auth_" + ProjectId
	InbucketId = "supabase_inbucket_" + ProjectId
	RealtimeId = "supabase_realtime_" + ProjectId
	RestId = "supabase_rest_" + ProjectId
	StorageId = "supabase_storage_" + ProjectId
	DifferId = "supabase_differ_" + ProjectId
	PgmetaId = "supabase_pg_meta_" + ProjectId
	StudioId = "supabase_studio_" + ProjectId

	return nil
}

func AssertSupabaseStartIsRunning() error {
	if err := LoadConfig(); err != nil {
		return err
	}

	if _, err := Docker.ContainerInspect(context.Background(), DbId); err != nil {
		return errors.New(Aqua("supabase start") + " is not running.")
	}

	return nil
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
) (io.Reader, error) {
	container, err := Docker.ContainerCreate(ctx, config, hostConfig, nil, nil, name)
	if err != nil {
		return nil, err
	}
	containers = append(containers, name)

	resp, err := Docker.ContainerAttach(ctx, container.ID, types.ContainerAttachOptions{Stream: true, Stdout: true, Stderr: true})
	if err != nil {
		return nil, err
	}

	if err := Docker.ContainerStart(ctx, container.ID, types.ContainerStartOptions{}); err != nil {
		return nil, err
	}

	return resp.Reader, nil
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
				// TODO: Handle errors
				// fmt.Fprintln(os.Stderr, err)
				_ = err
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

		if cwd, err := os.Getwd(); err != nil {
			return nil, err
		} else if IsRootDirectory(cwd) {
			return nil, nil
		}

		if err := os.Chdir(".."); err != nil {
			return nil, err
		}
	}
}

type (
	StatusMsg   string
	ProgressMsg *float64
	PsqlMsg     *string
)

func ProcessPullOutput(out io.ReadCloser, p Program) error {
	dec := json.NewDecoder(out)

	downloads := make(map[string]struct{ current, total int64 })

	for {
		var progress jsonmessage.JSONMessage

		if err := dec.Decode(&progress); err == io.EOF {
			break
		} else if err != nil {
			return err
		}

		if strings.HasPrefix(progress.Status, "Pulling from") {
			p.Send(StatusMsg(progress.Status + "..."))
		} else if progress.Status == "Pulling fs layer" || progress.Status == "Waiting" {
			downloads[progress.ID] = struct{ current, total int64 }{
				current: 0,
				total:   0,
			}
		} else if progress.Status == "Downloading" {
			downloads[progress.ID] = struct{ current, total int64 }{
				current: progress.Progress.Current,
				total:   progress.Progress.Total,
			}

			var sumCurrent, sumTotal int64
			for _, percentage := range downloads {
				sumCurrent += percentage.current
				sumTotal += percentage.total
			}

			var overallProgress float64
			if sumTotal != 0 {
				overallProgress = float64(sumCurrent) / float64(sumTotal)
			}
			p.Send(ProgressMsg(&overallProgress))
		}
	}

	p.Send(ProgressMsg(nil))

	return nil
}

func ProcessDiffOutput(p Program, out io.Reader) ([]byte, error) {
	var diffBytesBuf bytes.Buffer
	r, w := io.Pipe()
	doneCh := make(chan struct{}, 1)

	go func() {
		scanner := bufio.NewScanner(r)
		re := regexp.MustCompile(`(.*)([[:digit:]]{2,3})%`)

		for scanner.Scan() {
			select {
			case <-doneCh:
				return
			default:
			}

			line := scanner.Text()

			if line == "Starting schema diff..." {
				percentage := 0.0
				p.Send(ProgressMsg(&percentage))
			}

			matches := re.FindStringSubmatch(line)
			if len(matches) != 3 {
				continue
			}

			p.Send(StatusMsg(matches[1]))
			percentage, err := strconv.ParseFloat(matches[2], 64)
			if err != nil {
				continue
			}
			percentage = percentage / 100
			p.Send(ProgressMsg(&percentage))
		}
	}()

	if _, err := stdcopy.StdCopy(&diffBytesBuf, w, out); err != nil {
		return nil, err
	}

	doneCh <- struct{}{}
	p.Send(ProgressMsg(nil))

	// TODO: Remove when https://github.com/supabase/pgadmin4/issues/24 is fixed.
	diffBytes := bytes.TrimPrefix(diffBytesBuf.Bytes(), []byte("NOTE: Configuring authentication for DESKTOP mode.\n"))

	return filterDiffOutput(diffBytes)
}

func filterDiffOutput(diffBytes []byte) ([]byte, error) {
	var diffJson []DiffEntry
	if err := json.Unmarshal(diffBytes, &diffJson); err != nil {
		return nil, err
	}

	filteredDiffDdls := []string{`-- This script was generated by the Schema Diff utility in pgAdmin 4
-- For the circular dependencies, the order in which Schema Diff writes the objects is not very sophisticated
-- and may require manual changes to the script to ensure changes are applied in the correct order.
-- Please report an issue for any failure with the reproduction steps.`}

	for _, diffEntry := range diffJson {
		if diffEntry.Status == "Identical" || diffEntry.DiffDdl == "" {
			continue
		}

		switch diffEntry.Type {
		case "function", "mview", "table", "trigger_function", "type", "view":
			// skip
		default:
			continue
		}

		{
			doContinue := false
			for _, dep := range diffEntry.Dependencies {
				if dep.Type == "extension" {
					doContinue = true
					break
				}
			}

			if doContinue {
				continue
			}
		}

		if isSchemaIgnored(diffEntry.GroupName) ||
			// Needed at least for trigger_function
			(diffEntry.SourceSchemaName != nil && isSchemaIgnored(*diffEntry.SourceSchemaName)) {
			continue
		}

		filteredDiffDdls = append(filteredDiffDdls, strings.TrimSpace(diffEntry.DiffDdl))
	}

	return []byte(strings.Join(filteredDiffDdls, "\n\n") + "\n"), nil
}

func isSchemaIgnored(schema string) bool {
	ignoredSchemas := []string{"auth", "extensions", "pgbouncer", "realtime", "storage", "supabase_functions", "supabase_migrations"}
	for _, s := range ignoredSchemas {
		if s == schema {
			return true
		}
	}
	return false
}

func ProcessPsqlOutput(out io.Reader, p Program) error {
	r, w := io.Pipe()
	doneCh := make(chan struct{}, 1)

	go func() {
		scanner := bufio.NewScanner(r)

		for scanner.Scan() {
			select {
			case <-doneCh:
				return
			default:
			}

			line := scanner.Text()
			p.Send(PsqlMsg(&line))
		}
	}()

	var errBuf bytes.Buffer
	if _, err := stdcopy.StdCopy(w, &errBuf, out); err != nil {
		return err
	}
	if errBuf.Len() > 0 {
		return errors.New("Error running SQL: " + errBuf.String())
	}

	doneCh <- struct{}{}
	p.Send(PsqlMsg(nil))

	return nil
}

func IsBranchNameReserved(branch string) bool {
	switch branch {
	case "_current_branch", "main", "supabase_shadow", "postgres", "template0", "template1":
		return true
	default:
		return false
	}
}
