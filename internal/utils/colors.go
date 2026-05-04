package utils

import (
	"charm.land/lipgloss/v2"
)

// For commands & names.
func Aqua(str string) string {
	return lipgloss.Sprint(lipgloss.NewStyle().Foreground(lipgloss.Color("14")).SetString(str))
}

func Yellow(str string) string {
	return lipgloss.Sprint(lipgloss.NewStyle().Foreground(lipgloss.Color("11")).SetString(str))
}

func Green(str string) string {
	return lipgloss.Sprint(lipgloss.NewStyle().Foreground(lipgloss.Color("10")).SetString(str))
}

// For errors.
func Red(str string) string {
	return lipgloss.Sprint(lipgloss.NewStyle().Foreground(lipgloss.Color("9")).SetString(str))
}

// For paths & filenames.
func Bold(str string) string {
	return lipgloss.Sprint(lipgloss.NewStyle().Bold(true).SetString(str))
}
