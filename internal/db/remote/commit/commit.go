package commit

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
	pgx "github.com/jackc/pgx/v4"
	"github.com/supabase/cli/internal/utils"
)

// TODO: Handle cleanup on SIGINT/SIGTERM.
func Run() error {
	// Sanity checks.
	{
		if err := utils.AssertDockerIsRunning(); err != nil {
			return err
		}
		utils.LoadConfig()
	}

	url := os.Getenv("SUPABASE_REMOTE_DB_URL")
	if url == "" {
		return errors.New("Remote database is not set. Run `supabase db remote set` first.")
	}

	s := spinner.NewModel()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))
	p := tea.NewProgram(model{spinner: s})

	errCh := make(chan error, 1)
	go func() {
		errCh <- run(p, url)
		p.Send(tea.Quit())
	}()

	if err := p.Start(); err != nil {
		return err
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return errors.New("Aborted `supabase db remote commit`.")
	}
	if err := <-errCh; err != nil {
		return err
	}

	fmt.Println("Finished `supabase db remote commit`.")
	return nil
}

type model struct {
	spinner     spinner.Model
	status      string
	progress    *progress.Model
	psqlOutputs []string
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

	return m.spinner.View() + m.status + progress + psqlOutputs
}

const (
	netId    = "supabase_db_remote_commit_network"
	dbId     = "supabase_db_remote_commit_db"
	differId = "supabase_db_remote_commit_differ"
)

var ctx, cancelCtx = context.WithCancel(context.Background())

func run(p *tea.Program, url string) error {
	_, _ = utils.Docker.NetworkCreate(ctx, netId, types.NetworkCreate{CheckDuplicate: true})
	defer utils.Docker.NetworkRemove(context.Background(), netId) //nolint:errcheck

	defer utils.DockerRemoveAll()

	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

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
	}

	// 1. Assert `supabase/migrations` and `schema_migrations` are in sync.
	if rows, err := conn.Query(ctx, "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version"); err != nil {
		return err
	} else {
		versions := []string{}
		for rows.Next() {
			var version string
			if err := rows.Scan(&version); err != nil {
				return err
			}
			versions = append(versions, version)
		}

		migrations, err := os.ReadDir("supabase/migrations")
		if err != nil {
			return err
		}

		conflictErr := errors.New(
			"supabase_migrations.schema_migrations table is not in sync with the contents of `migrations` directory.",
		)

		if len(versions) != len(migrations) {
			return conflictErr
		}

		re := regexp.MustCompile(`([0-9]+)_.*\.sql`)
		for i, version := range versions {
			migrationTimestamp := re.FindStringSubmatch(migrations[i].Name())[1]

			if version == migrationTimestamp {
				continue
			}

			return conflictErr
		}
	}

	// 2. Create shadow db and run migrations.
	{
		p.Send(utils.StatusMsg("Creating shadow database..."))

		if _, err := utils.DockerRun(
			ctx,
			dbId,
			&container.Config{
				Image: utils.DbImage,
				Env:   []string{"POSTGRES_PASSWORD=postgres"},
				Cmd:   []string{"postgres", "-c", "wal_level=logical"},
			},
			&container.HostConfig{NetworkMode: netId},
		); err != nil {
			return err
		}
		out, err := utils.DockerExec(ctx, dbId, []string{
			"sh", "-c", "until pg_isready --host $(hostname --ip-address); do sleep 0.1; done",
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

		{
			globalsSql, err := os.ReadFile("supabase/globals.sql")
			if errors.Is(err, os.ErrNotExist) {
				return errors.New("Cannot find `supabase/globals.sql`.")
			} else if err != nil {
				return err
			}

			out, err := utils.DockerExec(ctx, dbId, []string{
				"sh", "-c", `psql --username postgres --dbname postgres <<'EOSQL'
BEGIN;
` + string(globalsSql) + `
COMMIT;
EOSQL
`,
			})
			if err != nil {
				return err
			}
			if err := utils.ProcessPsqlOutput(out, p); err != nil {
				return err
			}
		}

		{
			extensionsSql, err := os.ReadFile("supabase/extensions.sql")
			if errors.Is(err, os.ErrNotExist) {
				return errors.New("Cannot find `supabase/extensions.sql`.")
			} else if err != nil {
				return err
			}

			out, err := utils.DockerExec(ctx, dbId, []string{
				"sh", "-c", `psql --username postgres --dbname postgres <<'EOSQL'
BEGIN;
` + string(extensionsSql) + `
COMMIT;
EOSQL
`,
			})
			if err != nil {
				return err
			}
			if err := utils.ProcessPsqlOutput(out, p); err != nil {
				return err
			}
		}

		migrations, err := os.ReadDir("supabase/migrations")
		if err != nil {
			return err
		}

		for _, migration := range migrations {
			p.Send(utils.StatusMsg("Applying migration " + migration.Name() + "..."))

			content, err := os.ReadFile("supabase/migrations/" + migration.Name())
			if err != nil {
				return err
			}

			out, err := utils.DockerExec(ctx, dbId, []string{
				"sh", "-c", `psql --username postgres --dbname postgres <<'EOSQL'
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
				return err
			}
		}
	}

	timestamp := utils.GetCurrentTimestamp()

	// 3. Diff remote db (source) & shadow db (target) and write it as a new migration.
	{
		p.Send(utils.StatusMsg("Committing changes on remote database as a new migration..."))

		out, err := utils.DockerRun(
			ctx,
			differId,
			&container.Config{
				Image: utils.DifferImage,
				Entrypoint: []string{
					"sh", "-c", "/venv/bin/python3 -u cli.py --json-diff " +
						"'" + url + "' " +
						"'postgres://postgres:postgres@" + dbId + ":5432/postgres'",
				},
			},
			&container.HostConfig{NetworkMode: container.NetworkMode(netId)},
		)
		if err != nil {
			return err
		}

		diffBytes, err := utils.ProcessDiffOutput(p, out)
		if err != nil {
			return err
		}

		if err := os.WriteFile("supabase/migrations/"+timestamp+"_remote_commit.sql", diffBytes, 0644); err != nil {
			return err
		}
	}

	// 4. Insert a row to `schema_migrations`
	if _, err := conn.Query(ctx, "INSERT INTO supabase_migrations.schema_migrations(version) VALUES($1)", timestamp); err != nil {
		return err
	}

	return nil
}
