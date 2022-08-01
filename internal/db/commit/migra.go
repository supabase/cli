package commit

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/jsonmessage"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/debug"
	"github.com/supabase/cli/internal/utils"
)

const (
	migraId    = "supabase_migra_cli"
	diffImage  = "djrobstep/migra:3.0.1621480950"
	migrateDir = "supabase/migrations"
)

var (
	initSchemaPattern = regexp.MustCompile(`([0-9]{14})_init\.sql`)
	//go:embed templates/migra.sh
	diffSchemaScript string
	//go:embed templates/reset.sh
	resetShadowScript string
)

func RunMigra(name string, fsys afero.Fs) error {
	// Sanity checks.
	{
		if err := utils.AssertSupabaseStartIsRunning(); err != nil {
			return err
		}
	}

	var opts []func(*pgx.ConnConfig)
	if viper.GetBool("DEBUG") {
		opts = append(opts, debug.SetupPGX)
	}

	ctx := context.Background()
	// Trap Ctrl+C and call cancel on the context:
	// https://medium.com/@matryer/make-ctrl-c-cancel-the-context-context-bd006a8ad6ff
	ctx, cancel := context.WithCancel(ctx)
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt)
	defer func() {
		signal.Stop(c)
		cancel()
	}()
	go func() {
		select {
		case <-c:
			cancel()
		case <-ctx.Done():
		}
	}()

	fmt.Println("Creating shadow database...")
	if err := createShadowDb(ctx, utils.DbId, utils.ShadowDbName); err != nil {
		return err
	}

	fmt.Println("Initialising schema...")
	url := fmt.Sprintf("postgresql://postgres:postgres@localhost:%d/%s", utils.Config.Db.Port, utils.ShadowDbName)
	if err := applyMigrations(ctx, url, fsys, opts...); err != nil {
		return err
	}

	fmt.Println("Diffing local database...")
	baseUrl := "postgresql://postgres:postgres@" + utils.DbId + ":5432/"
	source := baseUrl + utils.ShadowDbName
	target := baseUrl + "postgres"
	diff, err := diffSchema(ctx, source, target)
	if err != nil {
		return err
	}

	if errors.Is(ctx.Err(), context.Canceled) {
		return errors.New("Aborted " + utils.Aqua("supabase db commit") + ".")
	}

	if len(diff) < 2 {
		fmt.Println("No changes found")
		return nil
	}

	filename := utils.GetCurrentTimestamp() + "_" + name + ".sql"
	if err := afero.WriteFile(fsys, filepath.Join(migrateDir, filename), []byte(diff), 0644); err != nil {
		return err
	}

	branch, err := utils.GetCurrentBranchFS(fsys)
	if err != nil {
		branch = "<unknown>"
	}

	fmt.Println("Finished " + utils.Aqua("supabase db commit") + " on branch " + utils.Aqua(branch) + `.

WARNING: You are using ` + utils.Aqua("--migra") + ` experimental flag to generate schema diffs.
If you discover any bugs, please report them to https://github.com/supabase/cli/issues.
Run ` + utils.Aqua("supabase db reset") + ` to verify that the new migration does not generate errors.`)

	return nil
}

func toBatchQuery(contents string) (batch pgx.Batch) {
	// batch := &pgx.Batch{}
	var lines []string
	for _, line := range strings.Split(contents, "\n") {
		trimmed := strings.TrimSpace(line)
		if len(trimmed) == 0 || strings.HasPrefix(trimmed, "--") {
			continue
		}
		lines = append(lines, trimmed)
		if strings.HasSuffix(trimmed, ";") {
			query := strings.Join(lines, "\n")
			batch.Queue(query[:len(query)-1])
			lines = nil
		}
	}
	if len(lines) > 0 {
		batch.Queue(strings.Join(lines, "\n"))
	}
	return batch
}

// Creates a fresh database inside supabase_cli_db container.
func createShadowDb(ctx context.Context, container, shadow string) error {
	// Reset shadow database
	exec, err := utils.Docker.ContainerExecCreate(ctx, container, types.ExecConfig{
		Cmd:          []string{"/bin/sh", "-c", resetShadowScript},
		Env:          []string{"DB_NAME=" + shadow, "SCHEMA=" + utils.InitialSchemaSql},
		AttachStderr: true,
		AttachStdout: true,
	})
	if err != nil {
		return err
	}
	// Read exec output
	resp, err := utils.Docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
	if err != nil {
		return err
	}
	// Capture error details
	var errBuf bytes.Buffer
	if _, err := stdcopy.StdCopy(io.Discard, &errBuf, resp.Reader); err != nil {
		return err
	}
	// Get the exit code
	iresp, err := utils.Docker.ContainerExecInspect(ctx, exec.ID)
	if err != nil {
		return err
	}
	if iresp.ExitCode > 0 {
		return errors.New("Error creating shadow database: " + errBuf.String())
	}
	return nil
}

// Applies local migration scripts to a database.
func applyMigrations(ctx context.Context, url string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// Parse connection url
	config, err := pgx.ParseConfig(url)
	if err != nil {
		return err
	}
	// Apply config overrides
	for _, op := range options {
		op(config)
	}
	// Connect to database
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	// Apply migrations
	if migrations, err := afero.ReadDir(fsys, migrateDir); err == nil {
		for i, migration := range migrations {
			// NOTE: To handle backward-compatibility. `<timestamp>_init.sql` as
			// the first migration (prev versions of the CLI) is deprecated.
			if i == 0 {
				matches := initSchemaPattern.FindStringSubmatch(migration.Name())
				if len(matches) == 2 {
					if timestamp, err := strconv.ParseUint(matches[1], 10, 64); err != nil {
						// Unreachable due to regex valdiation, but return just in case
						return err
					} else if timestamp < 20211209000000 {
						continue
					}
				}
			}
			fmt.Println("Applying migration " + utils.Bold(migration.Name()) + "...")
			contents, err := afero.ReadFile(fsys, filepath.Join(migrateDir, migration.Name()))
			if err != nil {
				return err
			}
			batch := toBatchQuery(string(contents))
			if err := conn.SendBatch(ctx, &batch).Close(); err != nil {
				return err
			}
		}
	}
	return nil
}

// Diffs local database schema against shadow, saves output as a migration script.
func diffSchema(ctx context.Context, source, target string) (string, error) {
	// Pull migra image
	imageUrl := "docker.io/" + diffImage
	if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, imageUrl); err != nil {
		out, err := utils.Docker.ImagePull(ctx, imageUrl, types.ImagePullOptions{})
		if err != nil {
			return "", err
		}
		dec := json.NewDecoder(out)
		for {
			var progress jsonmessage.JSONMessage
			if err := dec.Decode(&progress); err == io.EOF {
				break
			} else if err != nil {
				return "", err
			}
			fmt.Println(progress.Status)
		}
	}
	// Remove stale container, if any
	_ = utils.Docker.ContainerRemove(ctx, migraId, types.ContainerRemoveOptions{
		RemoveVolumes: true,
		Force:         true,
	})
	// Run migra
	out, err := utils.DockerRun(
		ctx,
		migraId,
		&container.Config{
			Image: imageUrl,
			Env:   []string{"SOURCE=" + source, "TARGET=" + target},
			Cmd:   []string{"/bin/sh", "-c", diffSchemaScript},
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.Config.ProjectId,
				"com.docker.compose.project": utils.Config.ProjectId,
			},
		},
		&container.HostConfig{
			NetworkMode: container.NetworkMode(utils.NetId),
			AutoRemove:  true,
		},
	)
	if err != nil {
		return "", err
	}
	// Copy output
	buf := new(strings.Builder)
	if _, err := stdcopy.StdCopy(buf, io.Discard, out); err != nil {
		return "", err
	}
	return buf.String(), nil
}
