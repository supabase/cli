package start

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"text/template"

	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"
	"github.com/fsnotify/fsnotify"
	"github.com/muesli/reflow/wrap"
	"github.com/supabase/cli/internal/utils"
)

// TODO: Handle cleanup on SIGINT/SIGTERM.
func Run() error {
	// Sanity checks.
	{
		if _, err := os.ReadDir("supabase"); errors.Is(err, os.ErrNotExist) {
			return errors.New("Cannot find " + utils.Bold("supabase") + " in the current directory. Have you set up the project with " + utils.Aqua("supabase init") + "?")
		} else if err != nil {
			return err
		}

		if err := utils.AssertDockerIsRunning(); err != nil {
			return err
		}

		if err := utils.LoadConfig(); err != nil {
			return err
		}
	}

	s := spinner.NewModel()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))
	p := tea.NewProgram(model{spinner: s})

	errCh := make(chan error, 1)
	go func() {
		errCh <- run(p)
		p.Send(tea.Quit())
	}()

	if err := p.Start(); err != nil {
		return err
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		fmt.Println("Stopped " + utils.Aqua("supabase start") + ".")
		return nil
	}
	if err := <-errCh; err != nil {
		return err
	}

	return nil
}

var (
	ctx, cancelCtx = context.WithCancel(context.Background())
	termCh         = make(chan struct{}, 1)

	// TODO: Unhardcode keys
	//go:embed templates/kong_config
	kongConfigEmbed       string
	kongConfigTemplate, _ = template.New("kongConfig").Parse(kongConfigEmbed)
)

func run(p *tea.Program) error {
	defer utils.Docker.NetworkRemove(context.Background(), utils.NetId) //nolint:errcheck

	defer utils.DockerRemoveAll()
	_, _ = utils.Docker.NetworkCreate(
		ctx,
		utils.NetId,
		types.NetworkCreate{
			CheckDuplicate: true,
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.ProjectId,
				"com.docker.compose.project": utils.ProjectId,
			},
		},
	)

	errCh := make(chan error)

	branchCh := make(chan string)

	// Ensure `_current_branch` file exists.
	if _, err := os.ReadFile("supabase/.branches/_current_branch"); err == nil {
		// skip
	} else if errors.Is(err, os.ErrNotExist) {
		if err := os.Mkdir("supabase/.branches", 0755); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		if err := os.WriteFile("supabase/.branches/_current_branch", []byte("main"), 0644); err != nil {
			return err
		}
	} else {
		return err
	}
	currBranch, err := utils.GetCurrentBranch()
	if err != nil {
		return err
	}

	// Set up watcher.
	{
		watcher, err := fsnotify.NewWatcher()
		if err != nil {
			return err
		}
		defer watcher.Close()

		if err := watcher.Add("supabase/.branches/_current_branch"); err != nil {
			return err
		}

		go func() {
			for {
				select {
				case _, ok := <-watcher.Events:
					if !ok {
						return
					}

					branch, err := utils.GetCurrentBranch()
					if err != nil {
						errCh <- fmt.Errorf("Error getting current branch name: %w", err)
						termCh <- struct{}{}
						return
					}
					branchCh <- branch
				case err, ok := <-watcher.Errors:
					if !ok {
						return
					}

					errCh <- err
					termCh <- struct{}{}
					return
				}
			}
		}()
	}

	_ = os.RemoveAll("supabase/.temp")
	if err := os.Mkdir("supabase/.temp", 0755); err != nil {
		return err
	}

	p.Send(utils.StatusMsg("Pulling images..."))

	// Pull images.
	{
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.DbImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.DbImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			if err := utils.ProcessPullOutput(out, p); err != nil {
				return err
			}
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.KongImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.KongImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			if err := utils.ProcessPullOutput(out, p); err != nil {
				return err
			}
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.GotrueImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.GotrueImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			if err := utils.ProcessPullOutput(out, p); err != nil {
				return err
			}
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.InbucketImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.InbucketImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			if err := utils.ProcessPullOutput(out, p); err != nil {
				return err
			}
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.RealtimeImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.RealtimeImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			if err := utils.ProcessPullOutput(out, p); err != nil {
				return err
			}
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.PostgrestImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.PostgrestImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			if err := utils.ProcessPullOutput(out, p); err != nil {
				return err
			}
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.StorageImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.StorageImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			if err := utils.ProcessPullOutput(out, p); err != nil {
				return err
			}
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
			if err := utils.ProcessPullOutput(out, p); err != nil {
				return err
			}
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.PgmetaImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.PgmetaImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			if err := utils.ProcessPullOutput(out, p); err != nil {
				return err
			}
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.StudioImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.StudioImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			if err := utils.ProcessPullOutput(out, p); err != nil {
				return err
			}
		}
	}

	p.Send(utils.StatusMsg("Starting database..."))

	// Start Postgres.
	{
		cmd := []string{}
		if dbVersion, err := strconv.ParseUint(utils.DbVersion, 10, 64); err != nil {
			return err
		} else if dbVersion >= 140000 {
			cmd = []string{"postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"}
		}

		if _, err := utils.DockerRun(
			ctx,
			utils.DbId,
			&container.Config{
				Image: utils.DbImage,
				Env:   []string{"POSTGRES_PASSWORD=postgres"},
				Cmd:   cmd,
				Labels: map[string]string{
					"com.supabase.cli.project":   utils.ProjectId,
					"com.docker.compose.project": utils.ProjectId,
				},
			},
			&container.HostConfig{
				NetworkMode:   container.NetworkMode(utils.NetId),
				PortBindings:  nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: utils.DbPort}}},
				RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
			},
		); err != nil {
			return err
		}

		out, err := utils.DockerExec(ctx, utils.DbId, []string{
			"sh", "-c", "until pg_isready --host $(hostname --ip-address); do sleep 0.1; done " +
				`&& psql --username postgres --host localhost <<'EOSQL'
BEGIN;
` + utils.GlobalsSql + `
COMMIT;
EOSQL
`,
		})
		if err != nil {
			return err
		}
		var errBuf bytes.Buffer
		if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
			return err
		}
		if errBuf.Len() > 0 {
			return errors.New("Error starting database: " + errBuf.String())
		}
	}

	p.Send(utils.StatusMsg("Restoring branches..."))

	// Restore branches.
	{
		if branches, err := os.ReadDir("supabase/.branches"); err == nil {
			for _, branch := range branches {
				if branch.Name() == "_current_branch" {
					continue
				}

				if err := func() error {
					content, err := os.ReadFile("supabase/.branches/" + branch.Name() + "/dump.sql")
					if errors.Is(err, os.ErrNotExist) {
						return errors.New("Branch was not dumped.")
					} else if err != nil {
						return err
					}

					out, err := utils.DockerExec(ctx, utils.DbId, []string{
						"sh", "-c", `psql --set ON_ERROR_STOP=on postgresql://postgres:postgres@localhost/postgres <<'EOSQL'
CREATE DATABASE "` + branch.Name() + `";
\connect ` + branch.Name() + `
BEGIN;
` + string(content) + `
COMMIT;
EOSQL
`,
					})
					if err != nil {
						return err
					}
					if err := utils.ProcessPsqlOutput(out, p); err != nil {
						return fmt.Errorf("Error starting database: %w", err)
					}

					return nil
				}(); err != nil {
					_ = os.RemoveAll("supabase/.branches/" + branch.Name())
					_ = os.WriteFile("supabase/.branches/_current_branch", []byte("main"), 0644)
					fmt.Fprintln(os.Stderr, "Error restoring branch "+utils.Aqua(branch.Name())+":", err)
				}
			}
		} else if errors.Is(err, os.ErrNotExist) {
			if err := os.Mkdir("supabase/.branches", 0755); err != nil {
				return err
			}
		} else {
			return err
		}

		// Ensure `main` branch exists.
		if _, err := os.ReadDir("supabase/.branches/main"); err == nil {
			// skip
		} else if errors.Is(err, os.ErrNotExist) {
			if err := os.Mkdir("supabase/.branches/main", 0755); err != nil {
				return err
			}

			if err := func() error {
				{
					out, err := utils.DockerExec(ctx, utils.DbId, []string{
						"createdb", "--username", "postgres", "--host", "localhost", "main",
					})
					if err != nil {
						return err
					}
					var errBuf bytes.Buffer
					if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
						return err
					}
					if errBuf.Len() > 0 {
						return errors.New("Error creating database: " + errBuf.String())
					}
				}

				p.Send(utils.StatusMsg("Setting up initial schema..."))
				{
					out, err := utils.DockerExec(ctx, utils.DbId, []string{
						"psql", "postgresql://postgres:postgres@localhost/main", "-c", utils.InitialSchemaSql,
					})
					if err != nil {
						return err
					}
					var errBuf bytes.Buffer
					if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
						return err
					}
					if errBuf.Len() > 0 {
						return errors.New("Error starting database: " + errBuf.String())
					}
				}

				p.Send(utils.StatusMsg("Applying " + utils.Bold("supabase/extensions.sql") + "..."))
				{
					extensionsSql, err := os.ReadFile("supabase/extensions.sql")
					if errors.Is(err, os.ErrNotExist) {
						// skip
					} else if err != nil {
						return err
					} else {
						out, err := utils.DockerExec(ctx, utils.DbId, []string{
							"psql", "postgresql://postgres:postgres@localhost/main", "-c", string(extensionsSql),
						})
						if err != nil {
							return err
						}
						var errBuf bytes.Buffer
						if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
							return err
						}
						if errBuf.Len() > 0 {
							return errors.New("Error starting database: " + errBuf.String())
						}
					}
				}

				migrations, err := os.ReadDir("supabase/migrations")
				if err != nil {
					return err
				}

				for i, migration := range migrations {
					// NOTE: To handle backward-compatibility.
					// `<timestamp>_init.sql` as the first migration (prev
					// versions of the CLI) is deprecated.
					if i == 0 {
						matches := regexp.MustCompile(`([0-9]{14})_init\.sql`).FindStringSubmatch(migration.Name())
						if len(matches) == 2 {
							if timestamp, err := strconv.ParseUint(matches[1], 10, 64); err != nil {
								return err
							} else if timestamp < 20211209000000 {
								continue
							}
						}
					}

					p.Send(utils.StatusMsg("Applying migration " + utils.Bold(migration.Name()) + "..."))

					content, err := os.ReadFile("supabase/migrations/" + migration.Name())
					if err != nil {
						return err
					}

					out, err := utils.DockerExec(ctx, utils.DbId, []string{
						"psql", "postgresql://postgres:postgres@localhost/main", "-c", string(content),
					})
					if err != nil {
						return err
					}
					var errBuf bytes.Buffer
					if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
						return err
					}
					if errBuf.Len() > 0 {
						return errors.New("Error starting database: " + errBuf.String())
					}
				}

				p.Send(utils.StatusMsg("Applying " + utils.Bold("supabase/seed.sql") + "..."))
				{
					content, err := os.ReadFile("supabase/seed.sql")
					if errors.Is(err, os.ErrNotExist) {
						// skip
					} else if err != nil {
						return err
					} else {
						out, err := utils.DockerExec(ctx, utils.DbId, []string{
							"psql", "postgresql://postgres:postgres@localhost/main", "-c", string(content),
						})
						if err != nil {
							return err
						}
						var errBuf bytes.Buffer
						if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
							return err
						}
						if errBuf.Len() > 0 {
							return errors.New("Error starting database: " + errBuf.String())
						}
					}
				}

				return nil
			}(); err != nil {
				_ = os.RemoveAll("supabase/.branches/main")
				return err
			}
		} else {
			return err
		}

		// Set up current branch.
		{
			out, err := utils.DockerExec(ctx, utils.DbId, []string{
				"sh", "-c", `psql --set ON_ERROR_STOP=on postgresql://postgres:postgres@localhost/template1 <<'EOSQL'
BEGIN;
` + fmt.Sprintf(utils.TerminateDbSqlFmt, "postgres") + `
COMMIT;
DROP DATABASE postgres;
ALTER DATABASE "` + currBranch + `" RENAME TO postgres;
EOSQL
`,
			})
			if err != nil {
				return err
			}
			var errBuf bytes.Buffer
			if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
				return err
			}
			if errBuf.Len() > 0 {
				return errors.New("Error starting database: " + errBuf.String())
			}
		}
	}

	p.Send(utils.StatusMsg("Starting containers..."))

	// Start Kong.
	{
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}

		var kongConfigBuf bytes.Buffer
		if err := kongConfigTemplate.Execute(&kongConfigBuf, struct{ ProjectId string }{ProjectId: utils.ProjectId}); err != nil {
			return err
		}
		if err := os.WriteFile("supabase/.temp/kong.yml", kongConfigBuf.Bytes(), 0644); err != nil {
			return err
		}
		// Ensure the file is readable even after umask
		if err := os.Chmod("supabase/.temp/kong.yml", 0644); err != nil {
			return err
		}

		if _, err := utils.DockerRun(
			ctx,
			utils.KongId,
			&container.Config{
				Image: utils.KongImage,
				Env: []string{
					"KONG_DATABASE=off",
					"KONG_DECLARATIVE_CONFIG=/var/lib/kong/kong.yml",
					"KONG_DNS_ORDER=LAST,A,CNAME", // https://github.com/supabase/cli/issues/14
					"KONG_PLUGINS=request-transformer,cors,key-auth",
				},
				Labels: map[string]string{
					"com.supabase.cli.project":   utils.ProjectId,
					"com.docker.compose.project": utils.ProjectId,
				},
			},
			&container.HostConfig{
				Binds:         []string{(cwd + "/supabase/.temp/kong.yml:/var/lib/kong/kong.yml:ro,z")},
				NetworkMode:   container.NetworkMode(utils.NetId),
				PortBindings:  nat.PortMap{"8000/tcp": []nat.PortBinding{{HostPort: utils.ApiPort}}},
				RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
			},
		); err != nil {
			return err
		}
	}

	// Start GoTrue.
	{
		env := []string{
			"API_EXTERNAL_URL=http://localhost:" + utils.ApiPort,

			"GOTRUE_API_HOST=0.0.0.0",
			"GOTRUE_API_PORT=9999",

			"GOTRUE_DB_DRIVER=postgres",
			"GOTRUE_DB_DATABASE_URL=postgresql://supabase_auth_admin:postgres@" + utils.DbId + ":5432/postgres",

			"GOTRUE_SITE_URL=http://localhost:3000",
			"GOTRUE_DISABLE_SIGNUP=false",

			"GOTRUE_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
			"GOTRUE_JWT_EXP=3600",
			"GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated",

			"GOTRUE_EXTERNAL_EMAIL_ENABLED=true",

			"GOTRUE_EXTERNAL_PHONE_ENABLED=true",
			"GOTRUE_SMS_AUTOCONFIRM=true",
		}

		if utils.InbucketPort == "" {
			env = append(env, "GOTRUE_MAILER_AUTOCONFIRM=true")
		} else {
			env = append(env,
				"GOTRUE_MAILER_AUTOCONFIRM=false",
				"GOTRUE_SMTP_HOST="+utils.InbucketId,
				"GOTRUE_SMTP_PORT=2500",
				"GOTRUE_SMTP_USER=GOTRUE_SMTP_USER",
				"GOTRUE_SMTP_PASS=GOTRUE_SMTP_PASS",
				"GOTRUE_SMTP_ADMIN_EMAIL=admin@email.com",
				"GOTRUE_MAILER_URLPATHS_INVITE=/auth/v1/verify",
				"GOTRUE_MAILER_URLPATHS_CONFIRMATION=/auth/v1/verify",
				"GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/v1/verify",
				"GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE=/auth/v1/verify",
			)
		}

		if _, err := utils.DockerRun(
			ctx,
			utils.GotrueId,
			&container.Config{
				Image: utils.GotrueImage,
				Env:   env,
				Labels: map[string]string{
					"com.supabase.cli.project":   utils.ProjectId,
					"com.docker.compose.project": utils.ProjectId,
				},
			},
			&container.HostConfig{
				NetworkMode:   container.NetworkMode(utils.NetId),
				RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
			},
		); err != nil {
			return err
		}
	}

	// Start Inbucket.
	if utils.InbucketPort != "" {
		if _, err := utils.DockerRun(
			ctx,
			utils.InbucketId,
			&container.Config{
				Image: utils.InbucketImage,
				Labels: map[string]string{
					"com.supabase.cli.project":   utils.ProjectId,
					"com.docker.compose.project": utils.ProjectId,
				},
			},
			&container.HostConfig{
				NetworkMode:   container.NetworkMode(utils.NetId),
				PortBindings:  nat.PortMap{"9000/tcp": []nat.PortBinding{{HostPort: utils.InbucketPort}}},
				RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
			},
		); err != nil {
			return err
		}
	}

	// Start Realtime.
	if _, err := utils.DockerRun(
		ctx,
		utils.RealtimeId,
		&container.Config{
			Image: utils.RealtimeImage,
			Env: []string{
				"PORT=4000",
				"DB_HOST=" + utils.DbId,
				"DB_PORT=5432",
				"DB_USER=postgres",
				"DB_PASSWORD=postgres",
				"DB_NAME=postgres",
				"DB_SSL=false",
				"SLOT_NAME=supabase_realtime",
				"TEMPORARY_SLOT=true",
				"JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
				"SECURE_CHANNELS=true",
				"REPLICATION_MODE=RLS",
				"REPLICATION_POLL_INTERVAL=100",
			},
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.ProjectId,
				"com.docker.compose.project": utils.ProjectId,
			},
		},
		&container.HostConfig{
			NetworkMode:   container.NetworkMode(utils.NetId),
			RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
		}); err != nil {
		return err
	}

	// Start PostgREST.
	if _, err := utils.DockerRun(
		ctx,
		utils.RestId,
		&container.Config{
			Image: utils.PostgrestImage,
			Env: []string{
				"PGRST_DB_URI=postgresql://postgres:postgres@" + utils.DbId + ":5432/postgres",
				"PGRST_DB_SCHEMA=public,storage",
				"PGRST_DB_ANON_ROLE=anon",
				"PGRST_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
			},
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.ProjectId,
				"com.docker.compose.project": utils.ProjectId,
			},
		},
		&container.HostConfig{
			NetworkMode:   container.NetworkMode(utils.NetId),
			RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
		},
	); err != nil {
		return err
	}

	// Start Storage.
	if _, err := utils.DockerRun(
		ctx,
		utils.StorageId,
		&container.Config{
			Image: utils.StorageImage,
			Env: []string{
				"ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.ZopqoUt20nEV9cklpv9e3yw3PVyZLmKs5qLD6nGL1SI",
				"SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.M2d2z4SFn5C7HlJlaSLfrzuYim9nbY_XI40uWFN3hEE",
				"POSTGREST_URL=http://" + utils.RestId + ":3000",
				"PGRST_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
				"DATABASE_URL=postgresql://supabase_storage_admin:postgres@" + utils.DbId + ":5432/postgres",
				"FILE_SIZE_LIMIT=52428800",
				"STORAGE_BACKEND=file",
				"FILE_STORAGE_BACKEND_PATH=/var/lib/storage",
				"TENANT_ID=stub",
				// TODO: https://github.com/supabase/storage-api/issues/55
				"REGION=stub",
				"GLOBAL_S3_BUCKET=stub",
			},
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.ProjectId,
				"com.docker.compose.project": utils.ProjectId,
			},
		},
		&container.HostConfig{
			NetworkMode:   container.NetworkMode(utils.NetId),
			RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
		},
	); err != nil {
		return err
	}

	// Start diff tool.
	if _, err := utils.DockerRun(
		ctx,
		utils.DifferId,
		&container.Config{
			Image:      utils.DifferImage,
			Entrypoint: []string{"sleep", "infinity"},
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.ProjectId,
				"com.docker.compose.project": utils.ProjectId,
			},
		},
		&container.HostConfig{
			NetworkMode:   container.NetworkMode(utils.NetId),
			RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
		},
	); err != nil {
		return err
	}

	// Start pg-meta.
	if _, err := utils.DockerRun(
		ctx,
		utils.PgmetaId,
		&container.Config{
			Image: utils.PgmetaImage,
			Env: []string{
				"PG_META_PORT=8080",
				"PG_META_DB_HOST=" + utils.DbId,
			},
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.ProjectId,
				"com.docker.compose.project": utils.ProjectId,
			},
		},
		&container.HostConfig{
			NetworkMode:   container.NetworkMode(utils.NetId),
			RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
		},
	); err != nil {
		return err
	}

	// Start Studio.
	if _, err := utils.DockerRun(
		ctx,
		utils.StudioId,
		&container.Config{
			Image: utils.StudioImage,
			Env: []string{
				"SUPABASE_URL=http://" + utils.KongId + ":8000",
				"STUDIO_PG_META_URL=http://" + utils.PgmetaId + ":8080",
				"SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.M2d2z4SFn5C7HlJlaSLfrzuYim9nbY_XI40uWFN3hEE",
			},
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.ProjectId,
				"com.docker.compose.project": utils.ProjectId,
			},
		},
		&container.HostConfig{
			NetworkMode:   container.NetworkMode(utils.NetId),
			PortBindings:  nat.PortMap{"3000/tcp": []nat.PortBinding{{HostPort: utils.StudioPort}}},
			RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
		},
	); err != nil {
		return err
	}

	p.Send(startedMsg(true))

	// switch db on switch branch

	prevBranch := currBranch
	for {
		select {
		case <-termCh:
			select {
			case err := <-errCh:
				return err
			default:
				return nil
			}
		case currBranch = <-branchCh:
		}

		p.Send(startedMsg(false))
		p.Send(utils.StatusMsg("Switching to branch " + currBranch + "..."))

		// Prevent new db connections to be established while db is recreated.
		if err := utils.Docker.NetworkDisconnect(ctx, utils.NetId, utils.DbId, false); err != nil {
			return err
		}

		// Recreate current branch.
		{
			out, err := utils.DockerExec(ctx, utils.DbId, []string{
				"sh", "-c", `psql --set ON_ERROR_STOP=on postgresql://postgres:postgres@localhost/template1 <<'EOSQL'
BEGIN;
` + fmt.Sprintf(utils.TerminateDbSqlFmt, "postgres") + `
COMMIT;
ALTER DATABASE postgres RENAME TO "` + prevBranch + `";
ALTER DATABASE "` + currBranch + `" RENAME TO postgres;
EOSQL
`,
			})
			if err != nil {
				return err
			}
			var errBuf bytes.Buffer
			if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
				return err
			}
			if errBuf.Len() > 0 {
				return errors.New("Error switching to branch " + utils.Aqua(currBranch) + ": " + errBuf.String())
			}
		}

		if err := utils.Docker.NetworkConnect(ctx, utils.NetId, utils.DbId, &network.EndpointSettings{}); err != nil {
			return err
		}

		prevBranch = currBranch

		p.Send(startedMsg(true))
	}
}

type startedMsg bool
type stopMsg struct{}

type model struct {
	spinner     spinner.Model
	status      string
	progress    *progress.Model
	psqlOutputs []string
	started     bool

	width int
}

func (m model) Init() tea.Cmd {
	return spinner.Tick
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyCtrlC:
			m.started = false
			m.status = "Dumping branches..."
			go cleanup(&m)
			return m, nil
		default:
			return m, nil
		}
	case tea.WindowSizeMsg:
		m.width = msg.Width
		return m, nil
	case spinner.TickMsg:
		spinnerModel, cmd := m.spinner.Update(msg)
		m.spinner = spinnerModel
		return m, cmd
	case progress.FrameMsg:
		if m.progress == nil {
			return m, nil
		}

		tmp, cmd := m.progress.Update(msg)
		progressModel := tmp.(progress.Model)
		m.progress = &progressModel
		return m, cmd
	case utils.StatusMsg:
		m.status = string(msg)
		return m, nil
	case utils.ProgressMsg:
		if msg == nil {
			m.progress = nil
			return m, nil
		}

		if m.progress == nil {
			progressModel := progress.NewModel(progress.WithDefaultGradient())
			m.progress = &progressModel
		}

		return m, m.progress.SetPercent(*msg)
	case utils.PsqlMsg:
		if msg == nil {
			m.psqlOutputs = []string{}
			return m, nil
		}

		m.psqlOutputs = append(m.psqlOutputs, *msg)
		if len(m.psqlOutputs) > 5 {
			m.psqlOutputs = m.psqlOutputs[1:]
		}
		return m, nil
	case startedMsg:
		m.started = bool(msg)
		return m, nil
	case stopMsg:
		return m, tea.Quit
	default:
		return m, nil
	}
}

func (m model) View() string {
	// TODO: Unhardcode keys
	if m.started {
		maybeInbucket := ""
		if utils.InbucketPort != "" {
			maybeInbucket = `
    ` + utils.Aqua("Inbucket URL") + `: http://localhost:` + utils.InbucketPort
		}

		return wrap.String(`Started local development setup.

         `+utils.Aqua("API URL")+`: http://localhost:`+utils.ApiPort+`
          `+utils.Aqua("DB URL")+`: postgresql://postgres:postgres@localhost:`+utils.DbPort+`/postgres
      `+utils.Aqua("Studio URL")+`: http://localhost:`+utils.StudioPort+maybeInbucket+`
        `+utils.Aqua("anon key")+`: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.ZopqoUt20nEV9cklpv9e3yw3PVyZLmKs5qLD6nGL1SI
`+utils.Aqua("service_role key")+`: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.M2d2z4SFn5C7HlJlaSLfrzuYim9nbY_XI40uWFN3hEE`, m.width)
	}

	var progress string
	if m.progress != nil {
		progress = "\n\n" + m.progress.View()
	}

	var psqlOutputs string
	if len(m.psqlOutputs) > 0 {
		psqlOutputs = "\n\n" + strings.Join(m.psqlOutputs, "\n")
	}

	return wrap.String(m.spinner.View()+m.status+progress+psqlOutputs, m.width)
}

func cleanup(m *model) {
	dumpBranches()
	// Stop future runs
	cancelCtx()
	// Stop current runs
	termCh <- struct{}{}
	m.Update(stopMsg{})
}

func dumpBranches() {
	branches, err := os.ReadDir("supabase/.branches")
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error dumping branches:", err)
		return
	}

	currBranch, err := utils.GetCurrentBranch()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error getting current branch:", err)
		return
	}

	for _, branch := range branches {
		if branch.Name() == "_current_branch" {
			continue
		}

		var dbName string
		if branch.Name() == currBranch {
			dbName = "postgres"
		} else {
			dbName = branch.Name()
		}

		if err := func() error {
			out, err := utils.DockerExec(ctx, utils.DbId, []string{
				"pg_dump", "postgresql://postgres:postgres@localhost/" + dbName,
			})
			if err != nil {
				return err
			}

			var dumpBuf, errBuf bytes.Buffer
			if _, err := stdcopy.StdCopy(&dumpBuf, &errBuf, out); err != nil {
				return err
			}
			if errBuf.Len() > 0 {
				return errors.New(errBuf.String())
			}

			if err := os.WriteFile("supabase/.branches/"+branch.Name()+"/dump.sql", dumpBuf.Bytes(), 0644); err != nil {
				return err
			}

			return nil
		}(); err != nil {
			fmt.Fprintln(os.Stderr, "Error dumping branch "+utils.Aqua(branch.Name())+":", err)
		}
	}
}
