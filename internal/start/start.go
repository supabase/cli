package start

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"text/template"

	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"
	"github.com/fsnotify/fsnotify"
	"github.com/supabase/cli/internal/utils"
)

// TODO: Handle cleanup on SIGINT/SIGTERM.
func Run() error {
	// Sanity checks.
	{
		if _, err := os.ReadDir("supabase"); errors.Is(err, os.ErrNotExist) {
			return errors.New(
				"Cannot find `supabase` in the current directory. Perhaps you meant to run `supabase init` first?",
			)
		} else if err != nil {
			return err
		}

		if err := utils.AssertDockerIsRunning(); err != nil {
			return err
		}

		utils.LoadConfig()

		if err := utils.AssertPortIsAvailable(utils.ApiPort); err != nil {
			return err
		}
		if err := utils.AssertPortIsAvailable(utils.DbPort); err != nil {
			return err
		}
		if err := utils.AssertPortIsAvailable(utils.PgmetaPort); err != nil {
			return err
		}
		if err := utils.AssertPortIsAvailable(utils.InbucketPort); err != nil {
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
		fmt.Println("Stopped `supabase start`.")
		return nil
	}
	if err := <-errCh; err != nil {
		return err
	}

	return nil
}

type model struct {
	spinner     spinner.Model
	status      string
	progress    *progress.Model
	psqlOutputs []string
	started     bool
}

func (m model) Init() tea.Cmd {
	return spinner.Tick
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyCtrlC:
			termCh <- struct{}{}
			dumpBranches()
			// Stop future runs
			cancelCtx()
			// Stop current runs
			utils.DockerRemoveAll()
			return m, tea.Quit
		default:
			return m, nil
		}
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
Inbucket URL: http://localhost:` + utils.InbucketPort
		}

		return `Started local development setup.
API URL: http://localhost:` + utils.ApiPort + `
DB URL: postgresql://postgres:postgres@localhost:` + utils.DbPort + "/postgres" + maybeInbucket + `
anon key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.ZopqoUt20nEV9cklpv9e3yw3PVyZLmKs5qLD6nGL1SI
service_role key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.M2d2z4SFn5C7HlJlaSLfrzuYim9nbY_XI40uWFN3hEE`
	}

	var progress string
	if m.progress != nil {
		progress = "\n\n" + m.progress.View()
	}

	var psqlOutputs string
	if len(m.psqlOutputs) > 0 {
		psqlOutputs = "\n\n" + strings.Join(m.psqlOutputs, "\n")
	}

	return m.spinner.View() + m.status + progress + psqlOutputs
}

type startedMsg bool

var (
	ctx, cancelCtx = context.WithCancel(context.Background())
	termCh         = make(chan struct{}, 1)

	//go:embed templates/pgbouncer_config
	pgbouncerConfigEmbed       string
	pgbouncerConfigTemplate, _ = template.New("pgbouncerConfig").Parse(pgbouncerConfigEmbed)
	//go:embed templates/pgbouncer_userlist
	pgbouncerUserlist []byte
	// TODO: Unhardcode keys
	//go:embed templates/kong_config
	kongConfigEmbed       string
	kongConfigTemplate, _ = template.New("kongConfig").Parse(kongConfigEmbed)
)

func run(p *tea.Program) error {
	defer utils.Docker.NetworkRemove(context.Background(), utils.NetId) //nolint:errcheck
	_, _ = utils.Docker.NetworkCreate(ctx, utils.NetId, types.NetworkCreate{CheckDuplicate: true})

	defer utils.DockerRemoveAll()

	// // Handle SIGINT/SIGTERM.
	// termCh := make(chan os.Signal, 1)
	// signal.Notify(termCh, syscall.SIGINT, syscall.SIGTERM)
	errCh := make(chan error)

	branchCh := make(chan string)

	// Ensure `current_branch` file exists.
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
						errCh <- errors.New("Error getting current branch name: " + err.Error())
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
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.PgbouncerImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.PgbouncerImage,
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
	}

	p.Send(utils.StatusMsg("Starting db container..."))

	// Start postgres.
	{
		if _, err := utils.DockerRun(
			ctx,
			utils.DbId,
			&container.Config{
				Image: utils.DbImage,
				Env:   []string{"POSTGRES_PASSWORD=postgres", "POSTGRES_DB=postgres"},
				Cmd:   []string{"postgres", "-c", "wal_level=logical"},
			},
			&container.HostConfig{
				NetworkMode: container.NetworkMode(utils.NetId),
			},
		); err != nil {
			return err
		}

		globalsSql, err := os.ReadFile("supabase/globals.sql")
		if err != nil {
			return errors.New("Cannot find `supabase/globals.sql`.")
		}

		out, err := utils.DockerExec(ctx, utils.DbId, []string{
			"sh", "-c", "until pg_isready --host $(hostname --ip-address); do sleep 0.1; done " +
				`&& psql --username postgres <<'EOSQL'
BEGIN;
` + string(globalsSql) + `
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
			return errors.New("Error waiting for database to start: " + errBuf.String())
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
					if err != nil {
						return err
					}

					out, err := utils.DockerExec(ctx, utils.DbId, []string{
						"sh", "-c", "createdb --username postgres '" + branch.Name() + "' && psql --username postgres --dbname '" + branch.Name() + `' <<'EOSQL'
BEGIN;
` + string(content) + `
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
						_ = os.RemoveAll("supabase/.branches/" + branch.Name() + "/dump.sql")
						return errors.New(errBuf.String())
					}

					return nil
				}(); err != nil {
					_ = os.RemoveAll("supabase/.branches/" + branch.Name())
					fmt.Fprintln(os.Stderr, "Error restoring branch "+branch.Name()+": "+err.Error())
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

			{
				out, err := utils.DockerExec(ctx, utils.DbId, []string{
					"sh", "-c", "createdb --username postgres main",
				})
				if err != nil {
					_ = os.RemoveAll("supabase/.branches/main")
					return err
				}
				if err := utils.ProcessPsqlOutput(out, p); err != nil {
					_ = os.RemoveAll("supabase/.branches/main")
					return err
				}
			}

			{
				p.Send(utils.StatusMsg("Applying extensions.sql..."))

				content, err := os.ReadFile("supabase/extensions.sql")
				if errors.Is(err, os.ErrNotExist) {
					return errors.New("Cannot find `supabase/extensions.sql`.")
				} else if err != nil {
					_ = os.RemoveAll("supabase/.branches/main")
					return err
				} else {
					out, err := utils.DockerExec(ctx, utils.DbId, []string{
						"sh", "-c", `psql --username postgres --dbname main <<'EOSQL'
BEGIN;
` + string(content) + `
COMMIT;
EOSQL
`,
					})
					if err != nil {
						_ = os.RemoveAll("supabase/.branches/main")
						return err
					}
					if err := utils.ProcessPsqlOutput(out, p); err != nil {
						_ = os.RemoveAll("supabase/.branches/main")
						return err
					}
				}
			}

			migrations, err := os.ReadDir("supabase/migrations")
			if err != nil {
				_ = os.RemoveAll("supabase/.branches/main")
				return err
			}

			for _, migration := range migrations {
				p.Send(utils.StatusMsg("Applying migration " + migration.Name() + "..."))

				content, err := os.ReadFile("supabase/migrations/" + migration.Name())
				if err != nil {
					_ = os.RemoveAll("supabase/.branches/main")
					return err
				}

				out, err := utils.DockerExec(ctx, utils.DbId, []string{
					"sh", "-c", `psql --username postgres --dbname main <<'EOSQL'
BEGIN;
` + string(content) + `
COMMIT;
EOSQL
`,
				})
				if err != nil {
					_ = os.RemoveAll("supabase/.branches/main")
					return err
				}
				if err := utils.ProcessPsqlOutput(out, p); err != nil {
					_ = os.RemoveAll("supabase/.branches/main")
					return err
				}
			}

			{
				p.Send(utils.StatusMsg("Applying seed.sql..."))

				content, err := os.ReadFile("supabase/seed.sql")
				if errors.Is(err, os.ErrNotExist) {
					// skip
				} else if err != nil {
					_ = os.RemoveAll("supabase/.branches/main")
					return err
				} else {
					out, err := utils.DockerExec(ctx, utils.DbId, []string{
						"sh", "-c", `psql --username postgres --dbname main <<'EOSQL'
BEGIN;
` + string(content) + `
COMMIT;
EOSQL
`,
					})
					if err != nil {
						_ = os.RemoveAll("supabase/.branches/main")
						return err
					}
					if err := utils.ProcessPsqlOutput(out, p); err != nil {
						_ = os.RemoveAll("supabase/.branches/main")
						return err
					}
				}
			}
		} else {
			return err
		}
	}

	p.Send(utils.StatusMsg("Starting containers..."))

	// Start pgbouncer.
	{
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}

		var pgbouncerConfigBuf bytes.Buffer
		if err := pgbouncerConfigTemplate.Execute(
			&pgbouncerConfigBuf,
			struct{ ProjectId, DbName string }{
				ProjectId: utils.ProjectId,
				DbName:    currBranch,
			},
		); err != nil {
			return err
		}
		if err := os.WriteFile("supabase/.temp/pgbouncer.ini", pgbouncerConfigBuf.Bytes(), 0644); err != nil {
			return err
		}
		if err := os.WriteFile("supabase/.temp/userlist.txt", pgbouncerUserlist, 0644); err != nil {
			return err
		}

		if _, err := utils.DockerRun(
			ctx,
			utils.PgbouncerId,
			&container.Config{
				Image: utils.PgbouncerImage,
				Env:   []string{"DB_USER=postgres", "DB_PASSWORD=postgres"},
			},
			&container.HostConfig{
				Binds: []string{
					cwd + "/supabase/.temp/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro",
					cwd + "/supabase/.temp/userlist.txt:/etc/pgbouncer/userlist.txt:ro",
				},
				PortBindings: nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: utils.DbPort}}},
				NetworkMode:  container.NetworkMode(utils.NetId),
			},
		); err != nil {
			return err
		}
	}

	// Start kong.
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
			},
			&container.HostConfig{
				Binds:        []string{(cwd + "/supabase/.temp/kong.yml:/var/lib/kong/kong.yml:ro")},
				PortBindings: nat.PortMap{"8000/tcp": []nat.PortBinding{{HostPort: utils.ApiPort}}},
				NetworkMode:  container.NetworkMode(utils.NetId),
			},
		); err != nil {
			return err
		}
	}

	// Start gotrue.

	{
		env := []string{
			"API_EXTERNAL_URL=http://localhost:" + utils.ApiPort,

			"GOTRUE_API_HOST=0.0.0.0",
			"GOTRUE_API_PORT=9999",

			"GOTRUE_DB_DRIVER=postgres",
			"GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:postgres@" + utils.PgbouncerId + ":5432/postgres?sslmode=disable",

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
			},
			&container.HostConfig{NetworkMode: container.NetworkMode(utils.NetId)},
		); err != nil {
			return err
		}
	}

	// Start Inbucket.
	if _, err := utils.DockerRun(ctx, utils.InbucketId, &container.Config{
		Image: utils.InbucketImage,
	},
		&container.HostConfig{
			PortBindings: nat.PortMap{"9000/tcp": []nat.PortBinding{{HostPort: utils.InbucketPort}}},
			NetworkMode:  container.NetworkMode(utils.NetId),
		},
	); err != nil {
		return err
	}

	// Start Realtime.

	{
		if _, err := utils.DockerRun(ctx, utils.RealtimeId, &container.Config{
			Image: utils.RealtimeImage,
			Env: []string{
				// connect to db directly instead of pgbouncer, since realtime doesn't work with pgbouncer for some reason
				"DB_HOST=" + utils.DbId,
				"DB_PORT=5432",
				"DB_USER=postgres",
				"DB_PASSWORD=postgres",
				"DB_NAME=" + currBranch,
				"SLOT_NAME=supabase_realtime",
				"PORT=4000",
				"SECURE_CHANNELS=true",
				"JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
			},
		}, &container.HostConfig{NetworkMode: container.NetworkMode(utils.NetId)}); err != nil {
			return err
		}
	}

	// start postgrest
	if _, err := utils.DockerRun(
		ctx,
		utils.RestId,
		&container.Config{
			Image: utils.PostgrestImage,
			Env: []string{
				"PGRST_DB_URI=postgres://postgres:postgres@" + utils.PgbouncerId + ":5432/postgres",
				"PGRST_DB_SCHEMA=public,storage",
				"PGRST_DB_ANON_ROLE=anon",
				"PGRST_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
			},
		},
		&container.HostConfig{NetworkMode: container.NetworkMode(utils.NetId)},
	); err != nil {
		return err
	}

	// start storage
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
				"DATABASE_URL=postgres://supabase_storage_admin:postgres@" + utils.PgbouncerId + ":5432/postgres?sslmode=disable&search_path=storage",
				"FILE_SIZE_LIMIT=52428800",
				"STORAGE_BACKEND=file",
				"FILE_STORAGE_BACKEND_PATH=/var/lib/storage",
				// TODO: https://github.com/supabase/storage-api/commit/a836fc9666c2434d89ca4b31402f74772d50fb6d
				"PROJECT_REF=stub",
				// TODO: https://github.com/supabase/storage-api/issues/55
				"REGION=stub",
				"GLOBAL_S3_BUCKET=stub",
			},
		},
		&container.HostConfig{NetworkMode: container.NetworkMode(utils.NetId)},
	); err != nil {
		return err
	}

	// start differ
	if _, err := utils.DockerRun(
		ctx,
		utils.DifferId,
		&container.Config{
			Image:      utils.DifferImage,
			Entrypoint: []string{"sleep", "infinity"},
		},
		&container.HostConfig{NetworkMode: container.NetworkMode(utils.NetId)},
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
				"PG_META_DB_HOST=" + utils.PgbouncerId,
			},
		},
		&container.HostConfig{
			PortBindings: nat.PortMap{"8080/tcp": []nat.PortBinding{{HostPort: utils.PgmetaPort}}},
			NetworkMode:  container.NetworkMode(utils.NetId),
		},
	); err != nil {
		return err
	}

	p.Send(startedMsg(true))

	// switch db on switch branch

	for {
		select {
		case <-termCh:
			p.Send(startedMsg(false))

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

		// reload pgbouncer

		var pgbouncerConfigBuf bytes.Buffer
		if err := pgbouncerConfigTemplate.Execute(
			&pgbouncerConfigBuf,
			struct{ ProjectId, DbName string }{
				ProjectId: utils.ProjectId,
				DbName:    currBranch,
			},
		); err != nil {
			return err
		}
		if err := os.WriteFile("supabase/.temp/pgbouncer.ini", pgbouncerConfigBuf.Bytes(), 0644); err != nil {
			return err
		}

		if err := utils.Docker.ContainerKill(ctx, utils.PgbouncerId, "SIGHUP"); err != nil {
			return err
		}

		// restart realtime, since the current db changed and it doesn't use pgbouncer

		if err := utils.Docker.ContainerRemove(ctx, utils.RealtimeId, types.ContainerRemoveOptions{
			RemoveVolumes: true,
			Force:         true,
		}); err != nil {
			return err
		}

		if _, err := utils.DockerRun(ctx, utils.RealtimeId, &container.Config{
			Image: utils.RealtimeImage,
			Env: []string{
				// connect to db directly instead of pgbouncer, since realtime doesn't work with pgbouncer for some reason
				"DB_HOST=" + utils.DbId,
				"DB_PORT=5432",
				"DB_USER=postgres",
				"DB_PASSWORD=postgres",
				"DB_NAME=" + currBranch,
				"SLOT_NAME=supabase_realtime",
				"PORT=4000",
				"SECURE_CHANNELS=true",
				"JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
			},
		}, &container.HostConfig{NetworkMode: container.NetworkMode(utils.NetId)}); err != nil {
			return err
		}

		p.Send(startedMsg(true))
	}
}

func dumpBranches() {
	branches, err := os.ReadDir("supabase/.branches")
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error dumping branches: "+err.Error())
		return
	}

	for _, branch := range branches {
		if branch.Name() == "_current_branch" {
			continue
		}

		if err := func() error {
			out, err := utils.DockerExec(ctx, utils.DbId, []string{
				"sh", "-c", "pg_dump --username postgres -d '" + branch.Name() + "'",
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
			fmt.Fprintln(os.Stderr, "Error dumping branch "+branch.Name()+": "+err.Error())
		}
	}
}
