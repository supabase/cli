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
	"github.com/muesli/reflow/wrap"
	"github.com/spf13/afero"
	differ "github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/remote/commit"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, username, password, database string, fsys afero.Fs) error {
	// Sanity checks.
	{
		if err := utils.AssertDockerIsRunning(); err != nil {
			return err
		}
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
	}

	ctx, cancel := context.WithCancel(ctx)
	s := spinner.NewModel()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))
	p := utils.NewProgram(model{cancel: cancel, spinner: s})

	errCh := make(chan error, 1)
	go func() {
		errCh <- run(p, ctx, username, password, database, fsys)
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

	return differ.SaveDiff(diff, "", fsys)
}

const (
	netId    = "supabase_db_remote_changes_network"
	dbId     = "supabase_db_remote_changes_db"
	differId = "supabase_db_remote_changes_differ"
)

var (
	diff string
)

func run(p utils.Program, ctx context.Context, username, password, database string, fsys afero.Fs) error {
	projectRef, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	host := utils.GetSupabaseDbHost(projectRef)
	conn, err := commit.ConnectRemotePostgres(ctx, username, password, database, host)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

	_, _ = utils.Docker.NetworkCreate(
		ctx,
		netId,
		types.NetworkCreate{
			CheckDuplicate: true,
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.Config.ProjectId,
				"com.docker.compose.project": utils.Config.ProjectId,
			},
		},
	)
	defer utils.DockerRemoveAll(context.Background(), netId)

	p.Send(utils.StatusMsg("Pulling images..."))

	// Pull images.
	{
		dbImage := utils.GetRegistryImageUrl(utils.DbImage)
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, dbImage); err != nil {
			out, err := utils.DockerImagePullWithRetry(ctx, dbImage, 2)
			if err != nil {
				return err
			}
			if err := utils.ProcessPullOutput(out, p); err != nil {
				return err
			}
		}
		diffImage := utils.GetRegistryImageUrl(utils.DifferImage)
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, diffImage); err != nil {
			out, err := utils.DockerImagePullWithRetry(ctx, diffImage, 2)
			if err != nil {
				return err
			}
			if err := utils.ProcessPullOutput(out, p); err != nil {
				return err
			}
		}
	}

	// 1. Assert `supabase/migrations` and `schema_migrations` are in sync.
	if err := commit.AssertRemoteInSync(ctx, conn, fsys); err != nil {
		return err
	}

	// 2. Create shadow db and run migrations.
	p.Send(utils.StatusMsg("Creating shadow database..."))
	{
		cmd := []string{}
		if utils.Config.Db.MajorVersion >= 14 {
			cmd = []string{"postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"}
		}

		if _, err := utils.DockerRun(
			ctx,
			dbId,
			&container.Config{
				Image: utils.GetRegistryImageUrl(utils.DbImage),
				Env:   []string{"POSTGRES_PASSWORD=postgres"},
				Cmd:   cmd,
				Labels: map[string]string{
					"com.supabase.cli.project":   utils.Config.ProjectId,
					"com.docker.compose.project": utils.Config.ProjectId,
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

		p.Send(utils.StatusMsg("Resetting database..."))
		if err := commit.ResetDatabase(ctx, dbId, utils.ShadowDbName); err != nil {
			return err
		}

		if err := utils.MkdirIfNotExist("supabase/migrations"); err != nil {
			return err
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
				"sh", "-c", "PGOPTIONS='--client-min-messages=error' psql postgresql://postgres:postgres@localhost/" + utils.ShadowDbName + ` <<'EOSQL'
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
				return errors.New("Error starting shadow database: " + errBuf.String())
			}
		}
	}

	// 3. Diff remote db (source) & shadow db (target) and print it.
	{
		p.Send(utils.StatusMsg("Generating changes on the remote database since the last migration..."))

		src := fmt.Sprintf(`"dbname='%s' user='%s' host='%s' password='%s'"`, database, username, host, password)
		dst := fmt.Sprintf(`"dbname='%s' user=postgres host='%s' password=postgres"`, utils.ShadowDbName, dbId)
		out, err := utils.DockerRun(
			ctx,
			differId,
			&container.Config{
				Image: utils.GetRegistryImageUrl(utils.DifferImage),
				Entrypoint: []string{
					"sh", "-c", "/venv/bin/python3 -u cli.py --json-diff " + src + " " + dst,
				},
				Labels: map[string]string{
					"com.supabase.cli.project":   utils.Config.ProjectId,
					"com.docker.compose.project": utils.Config.ProjectId,
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
			utils.DockerRemoveAll(context.Background(), netId)
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
