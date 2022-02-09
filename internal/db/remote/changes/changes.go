package changes

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
	pgx "github.com/jackc/pgx/v4"
	"github.com/muesli/reflow/wrap"
	"github.com/supabase/cli/internal/utils"
)

// TODO: Handle cleanup on SIGINT/SIGTERM.
func Run() error {
	// Sanity checks.
	{
		if err := utils.AssertDockerIsRunning(); err != nil {
			return err
		}
		if err := utils.LoadConfig(); err != nil {
			return err
		}
	}

	url := os.Getenv("SUPABASE_REMOTE_DB_URL")
	if url == "" {
		return errors.New("Remote database is not set. Run " + utils.Aqua("supabase db remote set") + " first.")
	}

	s := spinner.NewModel()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))
	p := utils.NewProgram(model{spinner: s})

	errCh := make(chan error, 1)
	go func() {
		errCh <- run(p, url)
		p.Send(tea.Quit())
	}()

	if err := p.Start(); err != nil {
		return err
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return errors.New("Aborted " + utils.Aqua("supabase db remote changes") + ".")
	}
	if err := <-errCh; err != nil {
		return err
	}

	fmt.Println(diff)
	return nil
}

const (
	netId    = "supabase_db_remote_changes_network"
	dbId     = "supabase_db_remote_changes_db"
	differId = "supabase_db_remote_changes_differ"
)

var (
	ctx, cancelCtx = context.WithCancel(context.Background())

	diff string
)

func run(p utils.Program, url string) error {
	_, _ = utils.Docker.NetworkCreate(
		ctx,
		netId,
		types.NetworkCreate{
			CheckDuplicate: true,
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.ProjectId,
				"com.docker.compose.project": utils.ProjectId,
			},
		},
	)
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
		remoteMigrations := []string{}
		for rows.Next() {
			var version string
			if err := rows.Scan(&version); err != nil {
				return err
			}
			remoteMigrations = append(remoteMigrations, version)
		}

		localMigrations, err := os.ReadDir("supabase/migrations")
		if err != nil {
			return err
		}

		conflictErr := errors.New("The remote database's migration history is not in sync with the contents of " + utils.Bold("supabase/migrations") + `. Resolve this by:
- Updating the project from version control to get the latest ` + utils.Bold("supabase/migrations") + `,
- Pushing unapplied migrations with ` + utils.Aqua("supabase db push") + `,
- Or failing that, manually inserting/deleting rows from the supabase_migrations.schema_migrations table on the remote database.`)

		if len(remoteMigrations) != len(localMigrations) {
			return conflictErr
		}

		re := regexp.MustCompile(`([0-9]+)_.*\.sql`)
		for i, remoteTimestamp := range remoteMigrations {
			localTimestamp := re.FindStringSubmatch(localMigrations[i].Name())[1]

			if localTimestamp == remoteTimestamp {
				continue
			}

			return conflictErr
		}
	}

	// 2. Create shadow db and run migrations.
	p.Send(utils.StatusMsg("Creating shadow database..."))
	{
		cmd := []string{}
		if dbVersion, err := strconv.ParseUint(utils.DbVersion, 10, 64); err != nil {
			return err
		} else if dbVersion >= 140000 {
			cmd = []string{"postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"}
		}

		if _, err := utils.DockerRun(
			ctx,
			dbId,
			&container.Config{
				Image: utils.DbImage,
				Env:   []string{"POSTGRES_PASSWORD=postgres"},
				Cmd:   cmd,
				Labels: map[string]string{
					"com.supabase.cli.project":   utils.ProjectId,
					"com.docker.compose.project": utils.ProjectId,
				},
			},
			&container.HostConfig{NetworkMode: netId},
		); err != nil {
			return err
		}

		out, err := utils.DockerExec(ctx, dbId, []string{
			"sh", "-c", "until pg_isready --host $(hostname --ip-address); do sleep 0.1; done " +
				`&& psql postgresql://postgres:postgres@localhost/postgres <<'EOSQL'
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
			return errors.New("Error starting shadow database: " + errBuf.String())
		}

		{
			out, err := utils.DockerExec(ctx, dbId, []string{
				"psql", "postgresql://postgres:postgres@localhost/postgres", "-c", utils.InitialSchemaSql,
			})
			if err != nil {
				return err
			}
			var errBuf bytes.Buffer
			if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
				return err
			}
			if errBuf.Len() > 0 {
				return errors.New("Error starting shadow database: " + errBuf.String())
			}
		}

		{
			extensionsSql, err := os.ReadFile("supabase/extensions.sql")
			if errors.Is(err, os.ErrNotExist) {
				// skip
			} else if err != nil {
				return err
			} else {
				out, err := utils.DockerExec(ctx, dbId, []string{
					"psql", "postgresql://postgres:postgres@localhost/postgres", "-c", string(extensionsSql),
				})
				if err != nil {
					return err
				}
				var errBuf bytes.Buffer
				if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
					return err
				}
				if errBuf.Len() > 0 {
					return errors.New("Error starting shadow database: " + errBuf.String())
				}
			}
		}

		migrations, err := os.ReadDir("supabase/migrations")
		if err != nil {
			return err
		}

		for i, migration := range migrations {
			// NOTE: To handle backward-compatibility. `<timestamp>_init.sql` as
			// the first migration (prev versions of the CLI) is deprecated.
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

			out, err := utils.DockerExec(ctx, dbId, []string{
				"psql", "postgresql://postgres:postgres@localhost/postgres", "-c", string(content),
			})
			if err != nil {
				return err
			}
			var errBuf bytes.Buffer
			if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
				return err
			}
			if errBuf.Len() > 0 {
				return errors.New("Error starting shadow database: " + errBuf.String())
			}
		}
	}

	// 3. Diff remote db (source) & shadow db (target) and print it.
	{
		p.Send(utils.StatusMsg("Generating changes on the remote database since the last migration..."))

		out, err := utils.DockerRun(
			ctx,
			differId,
			&container.Config{
				Image: utils.DifferImage,
				Entrypoint: []string{
					"sh", "-c", "/venv/bin/python3 -u cli.py --json-diff" +
						" '" + url + "'" +
						" 'postgresql://postgres:postgres@" + dbId + ":5432/postgres'",
				},
				Labels: map[string]string{
					"com.supabase.cli.project":   utils.ProjectId,
					"com.docker.compose.project": utils.ProjectId,
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

		diff = string(diffBytes)
	}

	return nil
}

type model struct {
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
			cancelCtx()
			// Stop current runs
			utils.DockerRemoveAll()
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

	return wrap.String(m.spinner.View()+m.status+progress+psqlOutputs, m.width)
}
