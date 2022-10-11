package start

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"text/template"
	"time"

	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/go-connections/nat"
	"github.com/muesli/reflow/wrap"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/lint"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	// Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUpFS(fsys); err != nil {
			return err
		}
		if err := utils.AssertDockerIsRunning(); err != nil {
			return err
		}
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
		if err := utils.AssertSupabaseDbIsRunning(); err == nil {
			return errors.New(utils.Aqua("supabase start") + " is already running. Try running " + utils.Aqua("supabase stop") + " first.")
		}
	}

	s := spinner.NewModel()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))
	ctx, cancel := context.WithCancel(ctx)
	p := utils.NewProgram(model{cancel: cancel, spinner: s})

	errCh := make(chan error, 1)
	go func() {
		errCh <- run(p, ctx, fsys)
		p.Send(tea.Quit())
	}()

	if err := p.Start(); err != nil {
		return err
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return errors.New("Aborted " + utils.Aqua("supabase start") + ".")
	}
	if err := <-errCh; err != nil {
		utils.DockerRemoveAll(context.Background(), utils.NetId)
		return err
	}

	fmt.Println("Started " + utils.Aqua("supabase") + " local development setup.")
	utils.ShowStatus()

	return nil
}

var (
	// TODO: Unhardcode keys
	//go:embed templates/kong_config
	kongConfigEmbed       string
	kongConfigTemplate, _ = template.New("kongConfig").Parse(kongConfigEmbed)
)

func pullImage(p utils.Program, ctx context.Context, image string) error {
	imageUrl := utils.GetRegistryImageUrl(image)
	_, _, err := utils.Docker.ImageInspectWithRaw(ctx, imageUrl)
	for i := 0; i < 3; i++ {
		if err == nil {
			break
		}
		var out io.ReadCloser
		out, err = utils.DockerImagePullWithRetry(ctx, imageUrl, 2)
		if err != nil {
			break
		}
		defer out.Close()
		if err := utils.ProcessPullOutput(out, p); err != nil {
			p.Send(utils.ProgressMsg(nil))
		}
		_, _, err = utils.Docker.ImageInspectWithRaw(ctx, imageUrl)
	}
	return err
}

func run(p utils.Program, ctx context.Context, fsys afero.Fs) error {
	_, _ = utils.Docker.NetworkCreate(
		ctx,
		utils.NetId,
		types.NetworkCreate{
			CheckDuplicate: true,
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.Config.ProjectId,
				"com.docker.compose.project": utils.Config.ProjectId,
			},
		},
	)

	p.Send(utils.StatusMsg("Pulling images..."))

	// Pull images.
	{
		if err := pullImage(p, ctx, utils.DbImage); err != nil {
			return err
		}
		for _, image := range utils.ServiceImages {
			if err := pullImage(p, ctx, image); err != nil {
				return err
			}
		}
	}

	p.Send(utils.StatusMsg("Starting database..."))

	// Start Postgres.
	{
		cmd := []string{}
		if utils.Config.Db.MajorVersion >= 14 {
			cmd = []string{"postgres",
				"-c", "config_file=/etc/postgresql/postgresql.conf",
				// One log file per hour, 24 hours retention
				"-c", "log_destination=csvlog",
				"-c", "logging_collector=on",
				"-c", "log_directory=/var/log/postgresql",
				"-c", "log_filename=server_%H00_UTC.log",
				"-c", "log_file_mode=0640",
				"-c", "log_rotation_age=60",
				"-c", "log_rotation_size=0",
				"-c", "log_truncate_on_rotation=on",
				// Ref: https://postgrespro.com/list/thread-id/2448092
				"-c", `search_path="$user",public,extensions`,
			}
		}

		if _, err := utils.DockerRun(
			ctx,
			utils.DbId,
			&container.Config{
				Image: utils.GetRegistryImageUrl(utils.DbImage),
				Env:   []string{"POSTGRES_PASSWORD=postgres"},
				Cmd:   cmd,
				Healthcheck: &container.HealthConfig{
					Test:     []string{"CMD", "pg_isready", "-U", "postgres", "-h", "localhost", "-p", "5432"},
					Interval: 2 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  10,
				},
				Labels: map[string]string{
					"com.supabase.cli.project":   utils.Config.ProjectId,
					"com.docker.compose.project": utils.Config.ProjectId,
				},
			},
			&container.HostConfig{
				NetworkMode:   container.NetworkMode(utils.NetId),
				PortBindings:  nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Db.Port), 10)}}},
				RestartPolicy: container.RestartPolicy{Name: "always"},
			},
		); err != nil {
			return err
		}

		if !reset.WaitForHealthyDatabase(ctx, 20*time.Second) {
			fmt.Fprintln(os.Stderr, "Database is not healthy.")
		}
	}

	// Initialise globals
	conn, err := lint.ConnectLocalPostgres(ctx, "localhost", utils.Config.Db.Port, "postgres")
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if err := diff.BatchExecDDL(ctx, conn, strings.NewReader(utils.GlobalsSql)); err != nil {
		return err
	}

	p.Send(utils.StatusMsg("Restoring branches..."))

	// Restore branches.
	{
		// Create branch dir if missing
		branchDir := filepath.Dir(utils.CurrBranchPath)
		if err := utils.MkdirIfNotExistFS(fsys, branchDir); err != nil {
			return err
		}
		branches, err := afero.ReadDir(fsys, branchDir)
		if err != nil {
			return err
		}
		// Ensure `_current_branch` file exists.
		currBranch, err := utils.GetCurrentBranchFS(fsys)
		if errors.Is(err, os.ErrNotExist) {
			currBranch = "main"
			if err := afero.WriteFile(fsys, utils.CurrBranchPath, []byte(currBranch), 0644); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		// Restore every branch dump
		for _, branch := range branches {
			if !branch.IsDir() {
				continue
			}
			dumpPath := filepath.Join(branchDir, branch.Name(), "dump.sql")
			content, err := fsys.Open(dumpPath)
			if errors.Is(err, os.ErrNotExist) {
				fmt.Fprintln(os.Stderr, "Error restoring "+utils.Aqua(branch.Name())+": branch was not dumped.")
				if err := fsys.RemoveAll(filepath.Dir(dumpPath)); err != nil {
					return err
				}
				continue
			} else if err != nil {
				return err
			}
			defer content.Close()
			// Restore current branch to postgres directly
			if branch.Name() == currBranch {
				if err := diff.BatchExecDDL(ctx, conn, content); err != nil {
					return err
				}
				continue
			}
			// TODO: restoring non-main branch may break extensions that require postgres
			createDb := `CREATE DATABASE "` + branch.Name() + `";`
			if _, err := conn.Exec(ctx, createDb); err != nil {
				return err
			}
			// Connect to branch database
			branchConn, err := lint.ConnectLocalPostgres(ctx, "localhost", utils.Config.Db.Port, branch.Name())
			if err != nil {
				return err
			}
			defer branchConn.Close(context.Background())
			// Restore dump, reporting any error
			if err := diff.BatchExecDDL(ctx, branchConn, content); err != nil {
				return err
			}
		}
		// Initialise main branch.
		if _, err := fsys.Stat(filepath.Join(branchDir, currBranch)); errors.Is(err, os.ErrNotExist) {

			p.Send(utils.StatusMsg("Setting up initial schema..."))

			if err := diff.BatchExecDDL(ctx, conn, strings.NewReader(utils.InitialSchemaSql)); err != nil {
				return err
			}

			if err := utils.MkdirIfNotExistFS(fsys, utils.MigrationsDir); err != nil {
				return err
			}

			if err := diff.MigrateDatabase(ctx, conn, fsys); err != nil {
				return err
			}

			p.Send(utils.StatusMsg("Applying " + utils.Bold(utils.SeedDataPath) + "..."))

			if content, err := fsys.Open(utils.SeedDataPath); err == nil {
				defer content.Close()
				if err := reset.BatchExecSQL(ctx, conn, content); err != nil {
					return err
				}
			} else if !errors.Is(err, os.ErrNotExist) {
				return err
			}

			// Ensure `main` branch exists.
			if err := fsys.Mkdir(filepath.Join(branchDir, currBranch), 0755); err != nil {
				return err
			}
		} else {
			return err
		}
	}

	p.Send(utils.StatusMsg("Starting containers..."))

	// Start Kong.
	{
		var kongConfigBuf bytes.Buffer
		if err := kongConfigTemplate.Execute(&kongConfigBuf, struct{ ProjectId, AnonKey, ServiceRoleKey string }{
			ProjectId:      utils.Config.ProjectId,
			AnonKey:        utils.AnonKey,
			ServiceRoleKey: utils.ServiceRoleKey,
		}); err != nil {
			return err
		}

		if _, err := utils.DockerRun(
			ctx,
			utils.KongId,
			&container.Config{
				Image: utils.GetRegistryImageUrl(utils.KongImage),
				Env: []string{
					"KONG_DATABASE=off",
					"KONG_DECLARATIVE_CONFIG=/home/kong/kong.yml",
					"KONG_DNS_ORDER=LAST,A,CNAME", // https://github.com/supabase/cli/issues/14
					"KONG_PLUGINS=request-transformer,cors,key-auth",
					// Need to increase the nginx buffers in kong to avoid it rejecting the rather
					// sizeable response headers azure can generate
					// Ref: https://github.com/Kong/kong/issues/3974#issuecomment-482105126
					"KONG_NGINX_PROXY_PROXY_BUFFER_SIZE=160k",
					"KONG_NGINX_PROXY_PROXY_BUFFERS=64 160k",
				},
				Entrypoint: []string{"sh", "-c", `cat <<'EOF' > /home/kong/kong.yml && ./docker-entrypoint.sh kong docker-start
` + kongConfigBuf.String() + `
EOF
`},
				Labels: map[string]string{
					"com.supabase.cli.project":   utils.Config.ProjectId,
					"com.docker.compose.project": utils.Config.ProjectId,
				},
			},
			&container.HostConfig{
				NetworkMode:   container.NetworkMode(utils.NetId),
				PortBindings:  nat.PortMap{"8000/tcp": []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Api.Port), 10)}}},
				RestartPolicy: container.RestartPolicy{Name: "always"},
			},
		); err != nil {
			return err
		}
	}

	// Start GoTrue.
	{
		env := []string{
			fmt.Sprintf("API_EXTERNAL_URL=http://localhost:%v", utils.Config.Api.Port),

			"GOTRUE_API_HOST=0.0.0.0",
			"GOTRUE_API_PORT=9999",

			"GOTRUE_DB_DRIVER=postgres",
			"GOTRUE_DB_DATABASE_URL=postgresql://supabase_auth_admin:postgres@" + utils.DbId + ":5432/postgres",

			"GOTRUE_SITE_URL=" + utils.Config.Auth.SiteUrl,
			"GOTRUE_URI_ALLOW_LIST=" + strings.Join(utils.Config.Auth.AdditionalRedirectUrls, ","),
			fmt.Sprintf("GOTRUE_DISABLE_SIGNUP=%v", !*utils.Config.Auth.EnableSignup),

			"GOTRUE_JWT_ADMIN_ROLES=service_role",
			"GOTRUE_JWT_AUD=authenticated",
			"GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated",
			fmt.Sprintf("GOTRUE_JWT_EXP=%v", utils.Config.Auth.JwtExpiry),
			"GOTRUE_JWT_SECRET=" + utils.JWTSecret,

			fmt.Sprintf("GOTRUE_EXTERNAL_EMAIL_ENABLED=%v", *utils.Config.Auth.Email.EnableSignup),
			fmt.Sprintf("GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED=%v", *utils.Config.Auth.Email.DoubleConfirmChanges),
			fmt.Sprintf("GOTRUE_MAILER_AUTOCONFIRM=%v", !*utils.Config.Auth.Email.EnableConfirmations),

			"GOTRUE_SMTP_HOST=" + utils.InbucketId,
			"GOTRUE_SMTP_PORT=2500",
			"GOTRUE_SMTP_ADMIN_EMAIL=admin@email.com",
			"GOTRUE_SMTP_MAX_FREQUENCY=1s",
			"GOTRUE_MAILER_URLPATHS_INVITE=/auth/v1/verify",
			"GOTRUE_MAILER_URLPATHS_CONFIRMATION=/auth/v1/verify",
			"GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/v1/verify",
			"GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE=/auth/v1/verify",

			"GOTRUE_EXTERNAL_PHONE_ENABLED=true",
			"GOTRUE_SMS_AUTOCONFIRM=true",
		}

		for name, config := range utils.Config.Auth.External {
			env = append(
				env,
				fmt.Sprintf("GOTRUE_EXTERNAL_%s_ENABLED=%v", strings.ToUpper(name), config.Enabled),
				fmt.Sprintf("GOTRUE_EXTERNAL_%s_CLIENT_ID=%s", strings.ToUpper(name), config.ClientId),
				fmt.Sprintf("GOTRUE_EXTERNAL_%s_SECRET=%s", strings.ToUpper(name), config.Secret),
				fmt.Sprintf("GOTRUE_EXTERNAL_%s_REDIRECT_URI=http://localhost:%v/auth/v1/callback", strings.ToUpper(name), utils.Config.Api.Port),
			)

			if config.Url != "" {
				env = append(env,
					fmt.Sprintf("GOTRUE_EXTERNAL_%s_URL=%s", strings.ToUpper(name), config.Url),
				)
			}
		}

		if _, err := utils.DockerRun(
			ctx,
			utils.GotrueId,
			&container.Config{
				Image: utils.GetRegistryImageUrl(utils.GotrueImage),
				Env:   env,
				Labels: map[string]string{
					"com.supabase.cli.project":   utils.Config.ProjectId,
					"com.docker.compose.project": utils.Config.ProjectId,
				},
			},
			&container.HostConfig{
				NetworkMode:   container.NetworkMode(utils.NetId),
				RestartPolicy: container.RestartPolicy{Name: "always"},
			},
		); err != nil {
			return err
		}
	}

	var inbucketPortBindings = nat.PortMap{"9000/tcp": []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Inbucket.Port), 10)}}}

	if utils.Config.Inbucket.SmtpPort != 0 {
		inbucketPortBindings["2500/tcp"] = []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Inbucket.SmtpPort), 10)}}
	}
	if utils.Config.Inbucket.Pop3Port != 0 {
		inbucketPortBindings["1100/tcp"] = []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Inbucket.Pop3Port), 10)}}
	}
	// Start Inbucket.
	if _, err := utils.DockerRun(
		ctx,
		utils.InbucketId,
		&container.Config{
			Image: utils.GetRegistryImageUrl(utils.InbucketImage),
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.Config.ProjectId,
				"com.docker.compose.project": utils.Config.ProjectId,
			},
		},
		&container.HostConfig{
			NetworkMode:   container.NetworkMode(utils.NetId),
			PortBindings:  inbucketPortBindings,
			RestartPolicy: container.RestartPolicy{Name: "always"},
		},
	); err != nil {
		return err
	}

	// Start Realtime.
	if _, err := utils.DockerRun(
		ctx,
		utils.RealtimeId,
		&container.Config{
			Image: utils.GetRegistryImageUrl(utils.RealtimeImage),
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
				"JWT_SECRET=" + utils.JWTSecret,
				"SECURE_CHANNELS=true",
				"REPLICATION_MODE=RLS",
				"REPLICATION_POLL_INTERVAL=100",
			},
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.Config.ProjectId,
				"com.docker.compose.project": utils.Config.ProjectId,
			},
		},
		&container.HostConfig{
			NetworkMode:   container.NetworkMode(utils.NetId),
			RestartPolicy: container.RestartPolicy{Name: "always"},
		}); err != nil {
		return err
	}

	// Start PostgREST.
	if _, err := utils.DockerRun(
		ctx,
		utils.RestId,
		&container.Config{
			Image: utils.GetRegistryImageUrl(utils.PostgrestImage),
			Env: []string{
				"PGRST_DB_URI=postgresql://postgres:postgres@" + utils.DbId + ":5432/postgres",
				"PGRST_DB_SCHEMAS=" + strings.Join(append([]string{"public", "storage", "graphql_public"}, utils.Config.Api.Schemas...), ","),
				"PGRST_DB_EXTRA_SEARCH_PATH=" + strings.Join(append([]string{"public"}, utils.Config.Api.ExtraSearchPath...), ","),
				"PGRST_DB_ANON_ROLE=anon",
				"PGRST_JWT_SECRET=" + utils.JWTSecret,
			},
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.Config.ProjectId,
				"com.docker.compose.project": utils.Config.ProjectId,
			},
		},
		&container.HostConfig{
			NetworkMode:   container.NetworkMode(utils.NetId),
			RestartPolicy: container.RestartPolicy{Name: "always"},
		},
	); err != nil {
		return err
	}

	// Start Storage.
	if _, err := utils.DockerRun(
		ctx,
		utils.StorageId,
		&container.Config{
			Image: utils.GetRegistryImageUrl(utils.StorageImage),
			Env: []string{
				"ANON_KEY=" + utils.AnonKey,
				"SERVICE_KEY=" + utils.ServiceRoleKey,
				"POSTGREST_URL=http://" + utils.RestId + ":3000",
				"PGRST_JWT_SECRET=" + utils.JWTSecret,
				"DATABASE_URL=postgresql://supabase_storage_admin:postgres@" + utils.DbId + ":5432/postgres",
				fmt.Sprintf("FILE_SIZE_LIMIT=%v", utils.Config.Storage.FileSizeLimit),
				"STORAGE_BACKEND=file",
				"FILE_STORAGE_BACKEND_PATH=/var/lib/storage",
				"TENANT_ID=stub",
				// TODO: https://github.com/supabase/storage-api/issues/55
				"REGION=stub",
				"GLOBAL_S3_BUCKET=stub",
			},
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.Config.ProjectId,
				"com.docker.compose.project": utils.Config.ProjectId,
			},
		},
		&container.HostConfig{
			NetworkMode:   container.NetworkMode(utils.NetId),
			RestartPolicy: container.RestartPolicy{Name: "always"},
		},
	); err != nil {
		return err
	}

	// Start diff tool.
	if _, err := utils.DockerRun(
		ctx,
		utils.DifferId,
		&container.Config{
			Image:      utils.GetRegistryImageUrl(utils.DifferImage),
			Entrypoint: []string{"sleep", "infinity"},
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.Config.ProjectId,
				"com.docker.compose.project": utils.Config.ProjectId,
			},
		},
		&container.HostConfig{
			NetworkMode:   container.NetworkMode(utils.NetId),
			RestartPolicy: container.RestartPolicy{Name: "always"},
		},
	); err != nil {
		return err
	}

	// Start pg-meta.
	if _, err := utils.DockerRun(
		ctx,
		utils.PgmetaId,
		&container.Config{
			Image: utils.GetRegistryImageUrl(utils.PgmetaImage),
			Env: []string{
				"PG_META_PORT=8080",
				"PG_META_DB_HOST=" + utils.DbId,
			},
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.Config.ProjectId,
				"com.docker.compose.project": utils.Config.ProjectId,
			},
		},
		&container.HostConfig{
			NetworkMode:   container.NetworkMode(utils.NetId),
			RestartPolicy: container.RestartPolicy{Name: "always"},
		},
	); err != nil {
		return err
	}

	// Start Studio.
	if _, err := utils.DockerRun(
		ctx,
		utils.StudioId,
		&container.Config{
			Image: utils.GetRegistryImageUrl(utils.StudioImage),
			Env: []string{
				"STUDIO_PG_META_URL=http://" + utils.PgmetaId + ":8080",
				"POSTGRES_PASSWORD=postgres",

				"SUPABASE_URL=http://" + utils.KongId + ":8000",
				fmt.Sprintf("SUPABASE_REST_URL=http://localhost:%v/rest/v1/", utils.Config.Api.Port),
				"SUPABASE_ANON_KEY=" + utils.AnonKey,
				"SUPABASE_SERVICE_KEY=" + utils.ServiceRoleKey,
			},
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.Config.ProjectId,
				"com.docker.compose.project": utils.Config.ProjectId,
			},
		},
		&container.HostConfig{
			NetworkMode:   container.NetworkMode(utils.NetId),
			PortBindings:  nat.PortMap{"3000/tcp": []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Studio.Port), 10)}}},
			RestartPolicy: container.RestartPolicy{Name: "always"},
		},
	); err != nil {
		return err
	}

	return nil
}

type model struct {
	cancel      context.CancelFunc
	spinner     spinner.Model
	status      string
	progress    *progress.Model
	psqlOutputs []string

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
			// Stop future runs
			m.cancel()
			// Stop current runs
			utils.DockerRemoveAll(context.Background(), utils.NetId)
			return m, tea.Quit
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
			progressModel := progress.NewModel(progress.WithGradient("#1c1c1c", "#34b27b"))
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
	default:
		return m, nil
	}
}

func (m model) View() string {
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
