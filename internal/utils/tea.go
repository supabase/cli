package utils

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/mattn/go-isatty"
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
