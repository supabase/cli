package utils

import (
	tea "github.com/charmbracelet/bubbletea"
)

// An interface describing the parts of BubbleTea's Program that we actually use.
type Program interface {
	Start() error
	Send(msg tea.Msg)
	Quit()
}
