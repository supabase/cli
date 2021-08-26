package init

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
	"syscall"
	"text/template"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/supabase/cli/internal/utils"
)

const (
	latestDbImage   = "supabase/postgres:13.3.0" // Latest supabase/postgres image on hosted platform.
	latestDbVersion = "130003"
	netId           = "supabase_init_net"
	dbId            = "supabase_init_db"
	differId        = "supabase_init_differ"
)

var (
	// pg_dump --dbname $DB_URL --schema-only
	//go:embed templates/init_migration_sql
	initMigrationSql []byte
	//go:embed templates/init_seed_sql
	initSeedSql []byte
	//go:embed templates/init_config
	initConfigEmbed       string
	initConfigTemplate, _ = template.New("initConfig").Parse(initConfigEmbed)
	//go:embed templates/init_gitignore
	initGitignore []byte

	ctx = context.TODO()
)

func Init() error {
	// Sanity checks.
	{
		if _, err := os.ReadDir(".git"); errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(
				os.Stderr,
				"❌ Cannot find `.git` in the current directory. Make sure you run the command in the root of a git repository.",
			)
			os.Exit(1)
		}

		if _, err := os.ReadDir("supabase"); err == nil {
			fmt.Fprintln(
				os.Stderr,
				"❌ Project already initialized. Remove `supabase` directory to reinitialize.",
			)
			os.Exit(1)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}

		utils.AssertDockerIsRunning()
	}

	_, _ = utils.Docker.NetworkCreate(ctx, netId, types.NetworkCreate{CheckDuplicate: true})
	defer utils.Docker.NetworkRemove(context.Background(), netId)

	defer utils.DockerRemoveAll()

	// Pull images.
	{
		// Don't know deploy db's version yet, so use latest image.
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+latestDbImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+latestDbImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			io.Copy(os.Stdout, out)
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.DifferImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.DifferImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			io.Copy(os.Stdout, out)
		}
	}

	// Handle cleanup on SIGINT/SIGTERM.
	{
		termCh := make(chan os.Signal, 1)
		signal.Notify(termCh, syscall.SIGINT, syscall.SIGTERM)
		go func() {
			<-termCh

			utils.DockerRemoveAll()
			utils.Docker.NetworkRemove(context.Background(), netId)

			fmt.Fprintln(os.Stderr, "Aborted `supabase init`.")
			os.Exit(1)
		}()
	}

	if err := os.Mkdir("supabase", 0755); err != nil {
		return err
	}

	// 1. Write `database`.
	{
		if err := os.Mkdir("supabase/database", 0755); err != nil {
			return err
		}
		if err := os.Mkdir("supabase/database/functions", 0755); err != nil {
			return err
		}
		if err := os.Mkdir("supabase/database/materialized_views", 0755); err != nil {
			return err
		}
		if err := os.Mkdir("supabase/database/tables", 0755); err != nil {
			return err
		}
		if err := os.Mkdir("supabase/database/types", 0755); err != nil {
			return err
		}
		if err := os.Mkdir("supabase/database/views", 0755); err != nil {
			return err
		}

		if err := os.Mkdir("supabase/.temp", 0755); err != nil {
			return err
		}
		defer os.RemoveAll("supabase/.temp")
		if err := os.WriteFile(
			"supabase/.temp/0_globals.sql",
			utils.FallbackGlobalsSql,
			0644,
		); err != nil {
			return err
		}
		if err := os.WriteFile(
			"supabase/.temp/1_init.sql",
			initMigrationSql,
			0644,
		); err != nil {
			return err
		}

		cwd, err := os.Getwd()
		if err != nil {
			return err
		}

		if err := utils.DockerRun(
			ctx,
			dbId,
			&container.Config{
				Image: latestDbImage,
				Env:   []string{"POSTGRES_PASSWORD=postgres"},
				Cmd: []string{
					"postgres", "-c", "wal_level=logical",
				},
			},
			&container.HostConfig{
				Binds:       []string{cwd + "/supabase/.temp:/docker-entrypoint-initdb.d"},
				NetworkMode: netId,
			},
		); err != nil {
			return err
		}

		if err := utils.DockerRun(ctx, differId, &container.Config{
			Image: utils.DifferImage,
			Cmd: []string{
				"--json-diff",
				"postgres://postgres:postgres@" + dbId + ":5432/postgres",
				"postgres://postgres:postgres@" + dbId + ":5432/template1",
			},
		}, &container.HostConfig{
			NetworkMode: netId,
		}); err != nil {
			return err
		}
		statusCh, errCh := utils.Docker.ContainerWait(
			ctx,
			differId,
			container.WaitConditionNotRunning,
		)
		select {
		case err := <-errCh:
			if err != nil {
				return err
			}
		case <-statusCh:
		}

		out, err := utils.Docker.ContainerLogs(
			ctx,
			differId,
			types.ContainerLogsOptions{ShowStdout: true},
		)
		if err != nil {
			return err
		}

		var diffBytesBuf bytes.Buffer
		if _, err := stdcopy.StdCopy(&diffBytesBuf, os.Stderr, out); err != nil {
			return err
		}

		var diffJson []utils.DiffEntry
		if err := json.Unmarshal(diffBytesBuf.Bytes(), &diffJson); err != nil {
			return err
		}

		for _, diffEntry := range diffJson {
			if diffEntry.GroupName == "extensions" ||
				(diffEntry.SourceSchemaName != nil && *diffEntry.SourceSchemaName == "extensions") {
				continue
			}

			switch diffEntry.Type {
			case "function":
				re := regexp.MustCompile(`(.+)\(.*\)`)
				name := re.FindStringSubmatch(diffEntry.Title)[1]
				if err := os.WriteFile(
					"supabase/database/functions/"+diffEntry.GroupName+"."+name+".sql",
					[]byte(diffEntry.SourceDdl),
					0644,
				); err != nil {
					return err
				}
			case "mview":
				if err := os.WriteFile(
					"supabase/database/materialized_views/"+diffEntry.GroupName+"."+diffEntry.Title+".sql",
					[]byte(diffEntry.SourceDdl),
					0644,
				); err != nil {
					return err
				}
			case "table":
				if err := os.WriteFile(
					"supabase/database/tables/"+diffEntry.GroupName+"."+diffEntry.Title+".sql",
					[]byte(diffEntry.SourceDdl),
					0644,
				); err != nil {
					return err
				}
			case "trigger_function":
				re := regexp.MustCompile(`(.+)\(.*\)`)
				var schema string
				if diffEntry.SourceSchemaName == nil {
					schema = "public"
				} else {
					schema = *diffEntry.SourceSchemaName
				}
				name := re.FindStringSubmatch(diffEntry.Title)[1]
				if err := os.WriteFile(
					"supabase/database/functions/"+schema+"."+name+".sql",
					[]byte(diffEntry.SourceDdl),
					0644,
				); err != nil {
					return err
				}
			case "type":
				if err := os.WriteFile(
					"supabase/database/types/"+diffEntry.GroupName+"."+diffEntry.Title+".sql",
					[]byte(diffEntry.SourceDdl),
					0644,
				); err != nil {
					return err
				}
			case "view":
				if err := os.WriteFile(
					"supabase/database/views/"+diffEntry.GroupName+"."+diffEntry.Title+".sql",
					[]byte(diffEntry.SourceDdl),
					0644,
				); err != nil {
					return err
				}
			}
		}
	}

	// 2. Write `migrations`.
	if err := os.Mkdir("supabase/migrations", 0755); err != nil {
		return err
	}
	if err := os.WriteFile(
		"supabase/migrations/"+utils.GetCurrentTimestamp()+"_init.sql",
		initMigrationSql,
		0644,
	); err != nil {
		return err
	}

	// 3. Write `.globals.sql`.
	if err := os.WriteFile("supabase/.globals.sql", utils.FallbackGlobalsSql, 0644); err != nil {
		return err
	}

	// 4. Write `config.json`.
	{
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}
		dir := filepath.Base(cwd)

		var initConfigBuf bytes.Buffer
		if err := initConfigTemplate.Execute(
			&initConfigBuf,
			struct{ ProjectId, DbVersion string }{
				ProjectId: dir,
				DbVersion: latestDbVersion,
			},
		); err != nil {
			return err
		}
		if err := os.WriteFile("supabase/config.json", initConfigBuf.Bytes(), 0644); err != nil {
			return err
		}
	}

	// 5. Write `seed.sql`.
	if err := os.WriteFile("supabase/seed.sql", initSeedSql, 0644); err != nil {
		return err
	}

	// 6. Append to `.gitignore`.
	{
		gitignore, err := os.ReadFile(".gitignore")
		if errors.Is(err, os.ErrNotExist) {
			// skip
		} else if err != nil {
			return err
		} else if bytes.Contains(gitignore, initGitignore) {
			// skip
		} else {
			f, err := os.OpenFile(".gitignore", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
			if err != nil {
				return err
			}
			if _, err := f.Write(initGitignore); err != nil {
				return err
			}
			if err := f.Close(); err != nil {
				return err
			}
		}
	}

	return nil
}
