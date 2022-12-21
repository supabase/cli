package utils

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-isatty"
	"github.com/muesli/reflow/wrap"
)

func NewProgram(model tea.Model, opts ...tea.ProgramOption) Program {
	var p Program
	if isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd()) {
		p = tea.NewProgram(model, opts...)
	} else {
		p = newFakeProgram(model)
	}
	return p
}

// An interface describing the parts of BubbleTea's Program that we actually use.
type Program interface {
	Start() error
	Send(msg tea.Msg)
	Quit()
}

func newFakeProgram(model tea.Model) *fakeProgram {
	p := &fakeProgram{
		model: model,
	}
	return p
}

// A dumb text implementation of BubbleTea's Program that allows
// for output to be piped to another program.
type fakeProgram struct {
	model tea.Model
}

func (p *fakeProgram) Start() error {
	initCmd := p.model.Init()
	message := initCmd()
	if message != nil {
		p.model.Update(message)
	}
	return nil
}

func (p *fakeProgram) Send(msg tea.Msg) {
	switch msg := msg.(type) {
	case StatusMsg:
		fmt.Println(msg)
	case PsqlMsg:
		if msg != nil {
			fmt.Println(*msg)
		}
	}

	_, cmd := p.model.Update(msg)
	if cmd != nil {
		cmd()
	}
}

func (p *fakeProgram) Quit() {
	p.Send(tea.Quit())
}

type (
	StatusMsg   string
	ProgressMsg *float64
	PsqlMsg     *string
)

func RunProgram(ctx context.Context, f func(p Program, ctx context.Context) error) error {
	ctx, cancel := context.WithCancel(ctx)
	p := NewProgram(logModel{
		cancel: cancel,
		spinner: spinner.NewModel(
			spinner.WithSpinner(spinner.Dot),
			spinner.WithStyle(lipgloss.NewStyle().Foreground(lipgloss.Color("205"))),
		),
	})

	errCh := make(chan error, 1)
	go func() {
		errCh <- f(p, ctx)
		p.Quit()
	}()

	if err := p.Start(); err != nil {
		return err
	}
	return <-errCh
}

type logModel struct {
	cancel context.CancelFunc

	spinner     spinner.Model
	status      string
	progress    *progress.Model
	psqlOutputs []string

	width int
}

func (m logModel) Init() tea.Cmd {
	return spinner.Tick
}

func (m logModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyCtrlC:
			if m.cancel != nil {
				m.cancel()
			}
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
	case StatusMsg:
		m.status = string(msg)
		return m, nil
	case ProgressMsg:
		if msg == nil {
			m.progress = nil
			return m, nil
		}

		if m.progress == nil {
			progressModel := progress.NewModel(progress.WithGradient("#1c1c1c", "#34b27b"))
			m.progress = &progressModel
		}

		return m, m.progress.SetPercent(*msg)
	case PsqlMsg:
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

func (m logModel) View() string {
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
