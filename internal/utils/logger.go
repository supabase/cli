package utils

import (
	"fmt"
	"io"
	"os"

	"github.com/spf13/viper"
)

// GetVerbosity returns the current verbosity level (0 = minimal, 1 = normal info, 2+ = more verbose)
func GetVerbosity() int {
	return viper.GetInt("VERBOSITY")
}

func GetDebugLogger() io.Writer {
	if viper.GetBool("DEBUG") {
		return os.Stderr
	}
	return io.Discard
}

// TODO: refactor across all codebase for consistency
// Info logs an info message to stderr if the current verbosity level is >= the required level
// level 0: always shown (important info)
// level 1: normal verbosity
// level 2+: high verbosity
func Info(level int, format string, args ...interface{}) {
	if GetVerbosity() >= level {
		message := fmt.Sprintf(format, args...)
		fmt.Fprintf(os.Stderr, "%s %s\n", Blue("INFO:"), message)
	}
}

// Debug logs a debug message to the debug logger (stderr when DEBUG=true, otherwise discarded)
func Debug(format string, args ...interface{}) {
	message := fmt.Sprintf(format, args...)
	fmt.Fprintf(GetDebugLogger(), "%s %s\n", Aqua("DEBUG:"), message)
}

// Warning logs a warning message to stderr with consistent formatting and styling
func Warning(format string, args ...interface{}) {
	message := fmt.Sprintf(format, args...)
	fmt.Fprintf(os.Stderr, "%s %s\n", Yellow("WARNING:"), message)
}
