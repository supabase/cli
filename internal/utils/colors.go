package utils

import (
	"github.com/charmbracelet/lipgloss"
)

// For commands & names.
func Aqua(str string) string {
	return lipgloss.NewStyle().Foreground(lipgloss.Color("14")).Render(str)
}

// For paths & filenames.
func Bold(str string) string {
	return lipgloss.NewStyle().Bold(true).Render(str)
}
