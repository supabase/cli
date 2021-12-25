package reset

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
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

		branch, err := utils.GetCurrentBranch()
		if err != nil {
			return err
		}
		currBranch = branch
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
		return errors.New("Aborted " + utils.Aqua("supabase db reset") + ".")
	}
	if err := <-errCh; err != nil {
		return err
	}

	fmt.Println("Finished " + utils.Aqua("supabase db reset") + " on branch " + utils.Aqua(currBranch) + ".")
	return nil
}

var (
	ctx, cancelCtx = context.WithCancel(context.Background())

	currBranch string
)

func run(p *tea.Program) (err error) {
	// 1. Pause realtime. Need to be done before recreating the db because we
	// cannot drop the db while there's an active logical replication slot.

	if err := utils.Docker.ContainerPause(ctx, utils.RealtimeId); err != nil {
		return err
	}
	defer func() {
		if err_ := utils.Docker.ContainerUnpause(ctx, utils.RealtimeId); err_ != nil {
			err = fmt.Errorf("Failed to unpause Realtime: %w", err_)
			return
		}
	}()

	p.Send(utils.StatusMsg("Resetting database..."))

	if err := func() error {
		// 2. Recreate db.
		{
			out, err := utils.DockerExec(ctx, utils.DbId, []string{
				"sh", "-c", "psql --username postgres --host localhost <<'EOSQL' " +
					"&& dropdb --force --username postgres --host localhost '" + currBranch + "' " +
					"&& createdb --username postgres --host localhost '" + currBranch + `'
BEGIN;
` + fmt.Sprintf(utils.TerminateDbSqlFmt, currBranch) + `
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
				return errors.New("Error resetting database: " + errBuf.String())
			}
		}

		// 3. Apply initial schema + extensions + migrations + seed.

		p.Send(utils.StatusMsg("Setting up initial schema..."))
		{
			out, err := utils.DockerExec(ctx, utils.DbId, []string{
				"sh", "-c", "psql --username postgres --host localhost --dbname '" + currBranch + `' <<'EOSQL'
BEGIN;
` + utils.InitialSchemaSql + `
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

		p.Send(utils.StatusMsg("Applying " + utils.Bold("supabase/extensions.sql") + "..."))
		{
			extensionsSql, err := os.ReadFile("supabase/extensions.sql")
			if errors.Is(err, os.ErrNotExist) {
				// skip
			} else if err != nil {
				return err
			} else {
				out, err := utils.DockerExec(ctx, utils.DbId, []string{
					"sh", "-c", "psql --username postgres --host localhost --dbname '" + currBranch + `' <<'EOSQL'
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
		}

		migrations, err := os.ReadDir("supabase/migrations")
		if err != nil {
			return err
		}

		for i, migration := range migrations {
			// NOTE: To handle backward-compatibility. `<timestamp>_init.sql` as
			// the first migration (prev versions of the CLI) is deprecated.
			if i == 0 && strings.HasSuffix(migration.Name(), "_init.sql") {
				continue
			}

			p.Send(utils.StatusMsg("Applying migration " + utils.Bold(migration.Name()) + "..."))

			content, err := os.ReadFile("supabase/migrations/" + migration.Name())
			if err != nil {
				return err
			}

			out, err := utils.DockerExec(ctx, utils.DbId, []string{
				"sh", "-c", "psql --username postgres --host localhost --dbname '" + currBranch + `' <<'EOSQL'
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

		p.Send(utils.StatusMsg("Applying " + utils.Bold("supabase/seed.sql") + "..."))
		{
			content, err := os.ReadFile("supabase/seed.sql")
			if errors.Is(err, os.ErrNotExist) {
				// skip
			} else if err != nil {
				return err
			} else {
				out, err := utils.DockerExec(ctx, utils.DbId, []string{
					"sh", "-c", "psql --username postgres --host localhost --dbname '" + currBranch + `' <<'EOSQL'
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

		return nil
	}(); err != nil {
		_ = os.RemoveAll("supabase/.branches/" + currBranch)
		return err
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
