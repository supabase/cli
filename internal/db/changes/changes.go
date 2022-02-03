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
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/muesli/reflow/wrap"
	"github.com/supabase/cli/internal/utils"
)

// TODO: Handle cleanup on SIGINT/SIGTERM.
func Run() error {
	// Sanity checks.
	{
		if err := utils.AssertSupabaseStartIsRunning(); err != nil {
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
		return errors.New("Aborted " + utils.Aqua("supabase db changes") + ".")
	}
	if err := <-errCh; err != nil {
		return err
	}

	fmt.Println(diff)
	return nil
}

var (
	ctx, cancelCtx = context.WithCancel(context.Background())

	diff string
)

func run(p utils.Program) error {
	p.Send(utils.StatusMsg("Creating shadow database..."))

	// 1. Create shadow db and run migrations
	{
		defer utils.DockerExec( //nolint:errcheck
			ctx,
			utils.DbId,
			[]string{"dropdb", "--username", "postgres", "--host", "localhost", utils.ShadowDbName},
		)
		out, err := utils.DockerExec(
			ctx,
			utils.DbId,
			[]string{"createdb", "--username", "postgres", "--host", "localhost", utils.ShadowDbName},
		)
		if err != nil {
			return err
		}
		var errBuf bytes.Buffer
		if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
			return err
		}
		if errBuf.Len() > 0 {
			return errors.New("Error creating shadow database: " + errBuf.String())
		}

		{
			out, err := utils.DockerExec(ctx, utils.DbId, []string{
				"psql", "postgresql://postgres:postgres@localhost/" + utils.ShadowDbName, "-c", utils.InitialSchemaSql,
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
				out, err := utils.DockerExec(ctx, utils.DbId, []string{
					"psql", "postgresql://postgres:postgres@localhost/" + utils.ShadowDbName, "-c", string(extensionsSql),
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

			out, err := utils.DockerExec(ctx, utils.DbId, []string{
				"psql", "postgresql://postgres:postgres@localhost/" + utils.ShadowDbName, "-c", string(content),
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

	p.Send(utils.StatusMsg("Diffing local database with current migrations..."))

	// 2. Diff local db (source) with shadow db (target), print it.
	{
		out, err := utils.DockerExec(ctx, utils.DifferId, []string{
			"sh", "-c", "/venv/bin/python3 -u cli.py --json-diff" +
				" 'postgresql://postgres:postgres@" + utils.DbId + ":5432/postgres'" +
				" 'postgresql://postgres:postgres@" + utils.DbId + ":5432/" + utils.ShadowDbName + "'",
		})
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
