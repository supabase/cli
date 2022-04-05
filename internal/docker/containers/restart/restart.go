package restart

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/docker/docker/api/types"
	"github.com/muesli/reflow/wrap"
	"github.com/supabase/cli/internal/utils"
)

var (
	ctx, cancelCtx = context.WithCancel(context.Background())
)

func Run() error {
	// Sanity checks.
	if err := utils.AssertDockerIsRunning(); err != nil {
		return err
	}
	if err := utils.LoadConfig(); err != nil {
		return err
	}

	containers, err := utils.GetProjectContainers(ctx)
	if err != nil {
		return err
	}

	if len(containers) == 0 {
		fmt.Println(fmt.Sprintf("There aren't any containers for %s project", utils.Bold(utils.Config.ProjectId)))
	} else {
		s := spinner.NewModel()
		s.Spinner = spinner.Dot
		s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))
		p := utils.NewProgram(model{spinner: s})

		errCh := make(chan error, 1)
		go func() {
			errCh <- run(p, containers)
			p.Send(tea.Quit())
		}()

		if err := p.Start(); err != nil {
			return err
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			return errors.New("Aborted " + utils.Aqua("supabase containers restart") + ".")
		}
		if err := <-errCh; err != nil {
			return err
		}
	}

	fmt.Println(`Supabase containers restarted.`)

	return nil
}

func run(p utils.Program, containers []types.Container) error {
	p.Send(utils.StatusMsg("Restarting docker containers..."))

	for _, container := range containers {
		timeout := time.Second
		status := fmt.Sprintf("Restaring %s", utils.Bold(utils.ContainerName(container.Names)))
		p.Send(utils.PsqlMsg(&status))
		err := utils.Docker.ContainerRestart(ctx, container.ID, &timeout)
		if err != nil {
			status := fmt.Sprintf("An error has ocurred trying to restart %s", utils.Bold(utils.Red(utils.ContainerName(container.Names))))
			p.Send(utils.PsqlMsg(&status))
		}
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
