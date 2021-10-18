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
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/jsonmessage"
	"github.com/docker/docker/pkg/stdcopy"
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
		docker, err := client.NewClientWithOpts(client.WithAPIVersionNegotiation())
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
	switch dbVersion {
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
		DbImage = "supabase/postgres:0.14.0"
	case
		"130000",
		"130001",
		"130002",
		"130003",
		"130004":
		DbImage = "supabase/postgres:13.3.0"
	default:
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
		} else if cwd == "/" {
			return nil, errors.New("Cannot find Git root. Are you in a Git repository?")
		}

		if err := os.Chdir(".."); err != nil {
			return nil, err
		}
	}
}

func IsSchemaIgnoredFromDump(schema string) bool {
	ignoredSchemas := []string{"auth", "extensions", "pgbouncer", "storage"}
	for _, s := range ignoredSchemas {
		if s == schema {
			return true
		}
	}
	return false
}

type (
	StatusMsg   string
	ProgressMsg *float64
	PsqlMsg     *string
)

func ProcessPullOutput(out io.ReadCloser, p *tea.Program) error {
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

func ProcessDiffOutput(p *tea.Program, out io.Reader) ([]byte, error) {
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

	return diffBytes, nil
}

func ProcessPsqlOutput(out io.Reader, p *tea.Program) error {
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
