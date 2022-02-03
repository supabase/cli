package utils

import (
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/mattn/go-isatty"
)

// An interface describing the parts of BubbleTea's Program that we actually use.
type Program interface {
	Start() error
	Send(msg tea.Msg)
	Quit()
}

// A dumb text implementation of BubbleTea's Program that allows
// for output to be piped to another program.
type FakeProgram struct {
	model tea.Model
}

func NewProgram(model tea.Model, opts ...tea.ProgramOption) Program {
	var p Program
	if isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd()) {
		p = tea.NewProgram(model, opts...)
	} else {
		p = NewFakeProgram(model)
	}
	return p
}

func NewFakeProgram(model tea.Model) *FakeProgram {
	p := &FakeProgram{
		model: model,
	}
	return p
}

func (p *FakeProgram) Start() error {
	initCmd := p.model.Init()
	message := initCmd()
	if message != nil {
		p.model.Update(message)
	}
	return nil
}

func (p *FakeProgram) Send(msg tea.Msg) {
	if msg == nil {
		return
	}

	switch msg := msg.(type) {
	case StatusMsg:
		os.Stdout.Write([]byte(msg + "\n"))

	case PsqlMsg:
		if msg != nil {
			os.Stdout.Write([]byte(*msg + "\n"))
		}
	}

	model, cmd := p.model.Update(msg)
	p.model = model

	if cmd != nil {
		cmd()
	}
}

func (p *FakeProgram) Quit() {
	p.Send(tea.Quit())
}
